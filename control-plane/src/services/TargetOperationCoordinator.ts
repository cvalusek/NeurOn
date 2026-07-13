export interface TargetDemandController {
  hasDemand(targetId: string): Promise<boolean>;
  reconcileTarget(targetId: string): Promise<void>;
}

export interface DiscoveryCapacitySnapshot {
  wasRunning: boolean;
}

interface ActiveDiscovery {
  holdsDesiredOn: boolean;
  promise: Promise<unknown>;
}

export class TargetOperationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetOperationConflictError";
  }
}

/**
 * Coordinates ephemeral target demand and provider lifecycle mutations.
 *
 * Discovery holds are operational demand only: the reconciler can observe them,
 * but they never become reservations or traffic/cost attribution records.
 */
export class TargetOperationCoordinator {
  private readonly discoveries = new Map<string, ActiveDiscovery>();
  private readonly forceStops = new Set<string>();
  private readonly transitionTails = new Map<string, Promise<void>>();
  private demandController?: TargetDemandController;

  setDemandController(controller: TargetDemandController): void {
    this.demandController = controller;
  }

  hasDesiredOnDemand(targetId: string): boolean {
    return this.discoveries.get(targetId)?.holdsDesiredOn === true;
  }

  isDiscoveryActive(targetId: string): boolean {
    return this.discoveries.has(targetId);
  }

  activeDiscoveryCount(): number {
    return this.discoveries.size;
  }

  runRuntimeModelDiscovery<T>(
    targetId: string,
    inspectCapacity: () => Promise<DiscoveryCapacitySnapshot>,
    operation: () => Promise<T>
  ): Promise<T> {
    const existing = this.discoveries.get(targetId);
    if (existing) return existing.promise as Promise<T>;
    if (this.forceStops.has(targetId)) {
      return Promise.reject(new TargetOperationConflictError(`Target ${targetId} is being force stopped; runtime model discovery cannot start`));
    }

    const demandController = this.demandController;
    if (!demandController) return Promise.reject(new Error("Target demand controller is not configured"));

    const active: ActiveDiscovery = {
      holdsDesiredOn: false,
      promise: Promise.resolve()
    };
    const promise = Promise.resolve()
      .then(async () => {
        let hasPrimaryError = false;
        let primaryError: unknown;
        let result: T | undefined;
        let releaseShouldReconcile = false;

        try {
          const acquisition = await this.withLifecycleTransition(targetId, async () => {
            const snapshot = await inspectCapacity();
            const hadDemand = await demandController.hasDemand(targetId);
            active.holdsDesiredOn = true;
            return { snapshot, hadDemand };
          });
          releaseShouldReconcile = !acquisition.snapshot.wasRunning || acquisition.hadDemand;
          await demandController.reconcileTarget(targetId);
          result = await operation();
        } catch (error) {
          hasPrimaryError = true;
          primaryError = error;
        }

        const heldDemand = active.holdsDesiredOn;
        active.holdsDesiredOn = false;
        if (heldDemand && releaseShouldReconcile) {
          try {
            await demandController.reconcileTarget(targetId);
          } catch (cleanupError) {
            if (hasPrimaryError) {
              primaryError = combinedOperationError(primaryError, cleanupError);
            } else {
              hasPrimaryError = true;
              primaryError = cleanupError;
            }
          }
        }

        if (hasPrimaryError) throw primaryError;
        return result as T;
      })
      .finally(() => {
        if (this.discoveries.get(targetId) === active) this.discoveries.delete(targetId);
      });

    active.promise = promise;
    this.discoveries.set(targetId, active);
    return promise;
  }

  runForceStop<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
    if (this.discoveries.has(targetId)) {
      return Promise.reject(new TargetOperationConflictError(`Target ${targetId} has runtime model discovery in progress; force stop was not started`));
    }
    if (this.forceStops.has(targetId)) {
      return Promise.reject(new TargetOperationConflictError(`Target ${targetId} is already being force stopped`));
    }

    this.forceStops.add(targetId);
    return this.withLifecycleTransition(targetId, operation).finally(() => {
      this.forceStops.delete(targetId);
    });
  }

  async withLifecycleTransition<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTails.get(targetId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.transitionTails.set(targetId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.transitionTails.get(targetId) === tail) this.transitionTails.delete(targetId);
    }
  }
}

function combinedOperationError(primary: unknown, cleanup: unknown): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const cleanupMessage = cleanup instanceof Error ? cleanup.message : String(cleanup);
  return new Error(`${primaryMessage}; lifecycle cleanup also failed: ${cleanupMessage}`, { cause: primary });
}
