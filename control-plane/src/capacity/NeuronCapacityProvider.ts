import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, NeuronProviderConfig } from "../domain/types.js";

const DEFAULT_RESERVATION_MINUTES = 5;

export class NeuronCapacityProvider implements CapacityProvider {
  private readonly reservationsByTargetId = new Map<string, string>();

  async provisionTarget(): Promise<void> {
    throw new Error("NeurOn provider targets are synced from the upstream NeurOn instance");
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const neuron = requireNeuronTarget(target);
    const config = requireNeuronProviderConfig(target);
    const reservationId = this.reservationsByTargetId.get(target.id);
    if (reservationId) {
      try {
        await this.request(config, `/api/reservations/${encodeURIComponent(reservationId)}/extend`, {
          method: "POST",
          body: JSON.stringify({ durationMinutes: reservationMinutes(config), fromNow: true })
        });
        return;
      } catch {
        this.reservationsByTargetId.delete(target.id);
      }
    }

    const reservation = await this.request<NeuronReservationResponse>(config, "/api/reservations", {
      method: "POST",
      body: JSON.stringify({
        targetIds: [neuron.targetId],
        durationMinutes: reservationMinutes(config)
      })
    });
    this.reservationsByTargetId.set(target.id, reservation.reservationId);
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const reservationId = this.reservationsByTargetId.get(target.id);
    if (!reservationId) return;
    const config = requireNeuronProviderConfig(target);
    try {
      await this.request(config, `/api/reservations/${encodeURIComponent(reservationId)}/done`, { method: "POST" });
    } finally {
      this.reservationsByTargetId.delete(target.id);
    }
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const neuron = requireNeuronTarget(target);
    const config = requireNeuronProviderConfig(target);
    const status = await this.request<NeuronStatusResponse>(config, "/api/status", { method: "GET" });
    const upstream = status.capacityTargets.find((candidate) => candidate.id === neuron.targetId);
    if (!upstream) return { observed: "failed", message: `Upstream NeurOn target not found: ${neuron.targetId}` };
    return {
      observed: upstream.observed,
      message: `Upstream NeurOn: ${upstream.message}`,
      details: upstream as Record<string, unknown>
    };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.ensureTargetOff(target);
  }

  private async request<T = unknown>(config: NeuronProviderConfig, path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${apiBaseUrl(config)}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey(config)}`,
        ...(init.headers ?? {})
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`NeurOn API returned ${response.status}${body ? `: ${body}` : ""}`);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

interface NeuronReservationResponse {
  reservationId: string;
}

interface NeuronStatusResponse {
  capacityTargets: Array<{
    id: string;
    observed: CapacityProviderStatus["observed"];
    message: string;
    [key: string]: unknown;
  }>;
}

function requireNeuronTarget(target: CapacityTarget) {
  if (!target.neuron) throw new Error(`Target ${target.id} is missing neuron config`);
  return target.neuron;
}

function requireNeuronProviderConfig(target: CapacityTarget): NeuronProviderConfig {
  const config = target.neuronProvider;
  if (!config) throw new Error(`Target ${target.id} is missing provider-level neuron config`);
  return config;
}

function apiBaseUrl(config: NeuronProviderConfig): string {
  if (!config.apiBaseUrl) throw new Error("NeurOn provider apiBaseUrl is required");
  return config.apiBaseUrl.replace(/\/$/, "");
}

function apiKey(config: NeuronProviderConfig): string {
  const value = config.apiKey ?? process.env[config.apiKeyEnv ?? "NEURON_API_KEY"];
  if (!value) throw new Error(`NeurOn API key is required; set ${config.apiKeyEnv ?? "NEURON_API_KEY"} or neuron.apiKey`);
  return value;
}

function reservationMinutes(config: NeuronProviderConfig): number {
  return config.reservationMinutes ?? DEFAULT_RESERVATION_MINUTES;
}
