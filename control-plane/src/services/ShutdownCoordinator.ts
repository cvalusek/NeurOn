import type { CapacityProvider, ReservationRepository, TargetStatusRepository } from "../domain/interfaces.js";
import type { CapacityTarget } from "../domain/types.js";
import type { Reconciler } from "../reconciler/Reconciler.js";
import type { TargetOperationCoordinator } from "./TargetOperationCoordinator.js";

export type ShutdownMode = "idle" | "draining" | "stopping-targets" | "failed" | "shutting-down";

export interface ShutdownStatus {
  mode: ShutdownMode;
  acceptingReservations: boolean;
  requestedAt?: string;
  requestedBy?: string;
  activeReservationCount: number;
  activeDiscoveryCount: number;
  activeDemandMutationCount: number;
  allTargetsStopped: boolean;
  targetStates: Array<{ id: string; displayName: string; desired: string; observed: string }>;
  message: string;
  forced: boolean;
  stopTargets: boolean;
  unmanagedCapacityRiskAccepted: boolean;
}

export interface ShutdownCoordinatorOptions {
  reservations: ReservationRepository;
  targets: () => CapacityTarget[];
  statuses: TargetStatusRepository;
  capacityProvider: CapacityProvider;
  reconciler: Reconciler;
  targetOperations: TargetOperationCoordinator;
  activeDemandMutations: () => number;
  stopTrafficPolling: () => void;
  resumeLifecycle: () => void;
  requestShutdown: (reason: string) => void | Promise<void>;
  pollIntervalMs?: number;
}

export class ShutdownCoordinator {
  private mode: ShutdownMode = "idle";
  private requestedAt?: Date;
  private requestedBy?: string;
  private message = "No restart is scheduled.";
  private forced = false;
  private stopTargets = false;
  private unmanagedCapacityRiskAccepted = false;
  private forceStopIssued = false;
  private interval?: NodeJS.Timeout;
  private evaluating?: Promise<void>;
  private generation = 0;

  constructor(private readonly options: ShutdownCoordinatorOptions) {}

  acceptingReservations(): boolean {
    return this.mode === "idle";
  }

  isDraining(): boolean {
    return this.mode !== "idle";
  }

  async status(now = new Date()): Promise<ShutdownStatus> {
    const activeReservations = await this.options.reservations.listActive(now);
    const targetStates = this.options.targets().map((target) => {
      const status = this.options.statuses.get(target.id);
      return {
        id: target.id,
        displayName: target.displayName,
        desired: status?.desired ?? "unknown",
        observed: status?.observed ?? "unknown"
      };
    });
    return {
      mode: this.mode,
      acceptingReservations: this.acceptingReservations(),
      requestedAt: this.requestedAt?.toISOString(),
      requestedBy: this.requestedBy,
      activeReservationCount: activeReservations.length,
      activeDiscoveryCount: this.options.targetOperations.activeDiscoveryCount(),
      activeDemandMutationCount: this.options.activeDemandMutations(),
      allTargetsStopped: targetStates.every((target) => target.desired === "off" && target.observed === "stopped"),
      targetStates,
      message: this.message,
      forced: this.forced,
      stopTargets: this.stopTargets,
      unmanagedCapacityRiskAccepted: this.unmanagedCapacityRiskAccepted
    };
  }

  scheduleWhenSafe(username: string): void {
    if (this.mode !== "idle") throw new Error("A restart is already scheduled");
    this.begin(username, false, false);
    this.mode = "draining";
    this.message = "Draining: new reservations and keepalives are blocked while active reservations finish.";
    this.startPolling();
    void this.evaluate();
  }

  force(username: string, stopTargets: boolean): void {
    if (this.mode === "shutting-down") throw new Error("NeurOn is already shutting down");
    if (this.mode === "stopping-targets") throw new Error("Target shutdown is already in progress");
    this.begin(username, true, stopTargets);
    if (!stopTargets) {
      this.unmanagedCapacityRiskAccepted = true;
      this.message = "Forced restart accepted without stopping targets. Running capacity may be left unmanaged if NeurOn does not return.";
      this.triggerShutdown("admin-forced-restart-without-target-stop");
      return;
    }
    this.mode = "stopping-targets";
    this.forceStopIssued = false;
    this.message = "Ending active reservations and preparing to stop every target before restart.";
    this.startPolling();
    void this.evaluate();
  }

  cancel(): void {
    if (this.mode === "idle") throw new Error("No restart is scheduled");
    if (this.mode === "shutting-down") throw new Error("Shutdown has already started");
    if (this.mode === "stopping-targets") throw new Error("A forced target shutdown cannot be cancelled while stop operations are in progress");
    this.generation += 1;
    this.stopPolling();
    this.mode = "idle";
    this.requestedAt = undefined;
    this.requestedBy = undefined;
    this.message = "No restart is scheduled.";
    this.forced = false;
    this.stopTargets = false;
    this.unmanagedCapacityRiskAccepted = false;
    this.forceStopIssued = false;
    this.options.resumeLifecycle();
  }

  stop(): void {
    this.stopPolling();
  }

  private begin(username: string, forced: boolean, stopTargets: boolean): void {
    this.generation += 1;
    this.stopPolling();
    this.options.stopTrafficPolling();
    this.requestedAt = new Date();
    this.requestedBy = username;
    this.forced = forced;
    this.stopTargets = stopTargets;
    this.unmanagedCapacityRiskAccepted = false;
  }

  private startPolling(): void {
    this.stopPolling();
    this.interval = setInterval(() => void this.evaluate(), this.options.pollIntervalMs ?? 2_000);
    this.interval.unref();
  }

  private stopPolling(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  private evaluate(): Promise<void> {
    if (this.evaluating) return this.evaluating;
    const generation = this.generation;
    this.evaluating = this.evaluateCurrentMode(generation)
      .catch((error) => {
        if (generation !== this.generation) return;
        this.mode = "failed";
        this.message = error instanceof Error ? error.message : String(error);
        this.stopPolling();
      })
      .finally(() => {
        this.evaluating = undefined;
      });
    return this.evaluating;
  }

  private async evaluateCurrentMode(generation: number): Promise<void> {
    if (this.mode === "draining") return this.evaluateSafeDrain(generation);
    if (this.mode === "stopping-targets") return this.evaluateForcedStop(generation);
  }

  private async evaluateSafeDrain(generation: number): Promise<void> {
    const demandMutations = this.options.activeDemandMutations();
    if (demandMutations > 0) {
      this.message = `Draining: waiting for ${demandMutations} in-flight reservation operation${demandMutations === 1 ? "" : "s"}.`;
      return;
    }
    const activeReservations = await this.options.reservations.listActive(new Date());
    if (!this.isCurrent(generation, "draining")) return;
    if (activeReservations.length > 0) {
      this.message = `Draining: waiting for ${activeReservations.length} active reservation${activeReservations.length === 1 ? "" : "s"}.`;
      return;
    }
    const discoveries = this.options.targetOperations.activeDiscoveryCount();
    if (discoveries > 0) {
      this.message = `Draining: waiting for ${discoveries} model discovery operation${discoveries === 1 ? "" : "s"}.`;
      return;
    }
    this.message = "No active reservations remain. Waiting for every target to report stopped.";
    await this.options.reconciler.requestReconcile();
    if (!this.isCurrent(generation, "draining")) return;
    if (this.allTargetsStopped()) this.triggerShutdown("safe-update-restart");
  }

  private async evaluateForcedStop(generation: number): Promise<void> {
    const demandMutations = this.options.activeDemandMutations();
    if (demandMutations > 0) {
      this.message = `Forced restart: waiting for ${demandMutations} in-flight reservation operation${demandMutations === 1 ? "" : "s"}.`;
      return;
    }
    const discoveries = this.options.targetOperations.activeDiscoveryCount();
    if (discoveries > 0) {
      this.message = `Forced restart: waiting for ${discoveries} model discovery operation${discoveries === 1 ? "" : "s"} before stopping targets.`;
      return;
    }
    if (!this.forceStopIssued) {
      this.options.reconciler.stop();
      const now = new Date();
      const activeReservations = await this.options.reservations.listActive(now);
      if (!this.isCurrent(generation, "stopping-targets")) return;
      await Promise.all(activeReservations.map((reservation) => this.options.reservations.update(reservation.id, {
        status: "failed",
        endedAt: now,
        failureMessage: "Ended by an administrator for a forced NeurOn restart"
      })));
      await this.refreshTargetStates();
      if (!this.isCurrent(generation, "stopping-targets")) return;
      const targetsToStop = this.options.targets().filter((target) => this.options.statuses.get(target.id)?.observed !== "stopped");
      const results = await Promise.allSettled(targetsToStop.map((target) =>
        this.options.targetOperations.runForceStop(target.id, () => this.options.capacityProvider.forceStopTarget(target))
      ));
      if (!this.isCurrent(generation, "stopping-targets")) return;
      const errors = results
        .map((result, index) => result.status === "rejected" ? `${targetsToStop[index].id}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}` : undefined)
        .filter((error): error is string => Boolean(error));
      if (errors.length > 0) throw new Error(`Could not stop all targets: ${errors.join("; ")}`);
      this.forceStopIssued = true;
    }
    await this.refreshTargetStates();
    if (!this.isCurrent(generation, "stopping-targets")) return;
    if (this.allTargetsStopped()) {
      this.triggerShutdown("admin-forced-restart-after-target-stop");
    } else {
      this.message = "Stop commands completed. Waiting for every target to report stopped.";
    }
  }

  private async refreshTargetStates(): Promise<void> {
    await Promise.all(this.options.targets().map(async (target) => {
      const providerStatus = await this.options.capacityProvider.getTargetStatus(target);
      const observed = providerStatus.observed === "healthy" ? "stopping" : providerStatus.observed;
      this.options.statuses.set({ targetId: target.id, desired: "off", observed, message: providerStatus.message, lastCheckedAt: new Date() });
    }));
  }

  private allTargetsStopped(): boolean {
    return this.options.targets().every((target) => {
      const status = this.options.statuses.get(target.id);
      return status?.desired === "off" && status.observed === "stopped";
    });
  }

  private triggerShutdown(reason: string): void {
    if (this.mode === "shutting-down") return;
    this.mode = "shutting-down";
    this.message = "Safety conditions are satisfied. NeurOn is shutting down so the service can restart on the new image.";
    this.stopPolling();
    const timer = setTimeout(() => void this.options.requestShutdown(reason), 500);
    timer.unref();
  }

  private isCurrent(generation: number, mode: ShutdownMode): boolean {
    return generation === this.generation && this.mode === mode;
  }
}
