export type TargetHostingMode = "dedicated" | "multi-model";

export function targetHostingMode(modelCount: number): TargetHostingMode | undefined {
  if (modelCount === 1) return "dedicated";
  if (modelCount > 1) return "multi-model";
  return undefined;
}
