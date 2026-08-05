import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

export function withProviderRuntimeEndpoints(target: CapacityTarget, status: CapacityProviderStatus): CapacityTarget {
  const apiUrl = target.apiUrl ?? status.runtime?.apiUrl;
  const healthUrl = target.healthUrl ?? status.runtime?.healthUrl;
  if (apiUrl === target.apiUrl && healthUrl === target.healthUrl) return target;
  return { ...target, apiUrl, healthUrl };
}
