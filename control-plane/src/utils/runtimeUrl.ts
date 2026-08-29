import type { CapacityTarget } from "../domain/types.js";

/** Browser-safe root URL for an authenticated user to open the target runtime directly. */
export function directRuntimeHostUrl(target: CapacityTarget): string | undefined {
  const runpodPodId = target.runpod?.podId?.trim();
  const runpodPort = target.runpod?.runtimePort ?? 8080;
  const derivedRunpod = target.provider === "runpod"
    && runpodPodId
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(runpodPodId)
    && Number.isInteger(runpodPort)
    && runpodPort >= 1
    && runpodPort <= 65_535
      ? `https://${runpodPodId}-${runpodPort}.proxy.runpod.net/v1`
      : undefined;
  const configured = target.apiUrl ?? target.litellm?.apiBaseUrl ?? derivedRunpod;
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) return undefined;
    url.pathname = url.pathname.replace(/\/v1\/?$/u, "/");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
