import type { CapacityTarget } from "../domain/types.js";

/** Browser-safe root URL for an authenticated user to open the target runtime directly. */
export function directRuntimeHostUrl(target: CapacityTarget): string | undefined {
  const configured = target.apiUrl ?? target.litellm?.apiBaseUrl;
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
