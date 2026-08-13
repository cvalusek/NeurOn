import type { ReservationProfileSelection } from "../domain/types.js";
import { ModelCatalog } from "./ModelCatalog.js";

export function normalizeReservationProfileSelections(catalog: ModelCatalog, selections: ReservationProfileSelection[]): ReservationProfileSelection[] {
  if (selections.length === 0) throw new Error("Add at least one target to the reservation profile");
  if (new Set(selections.map((selection) => selection.targetId)).size !== selections.length) {
    throw new Error("Each target can only be added once to a reservation profile");
  }
  return selections.map((selection) => {
    const targetId = catalog.validateTargetIds([selection.targetId])[0];
    const availableModels = catalog.listModelsForTarget(targetId);
    const requestedModelIds = unique(selection.modelIds);
    if (requestedModelIds.length === 0 && availableModels.length > 1) {
      throw new Error(`Choose at least one model for target: ${targetId}`);
    }
    const modelIds = requestedModelIds.length === 0 && availableModels.length === 1
      ? [availableModels[0].id]
      : catalog.canonicalModelIds(requestedModelIds);
    for (const modelId of modelIds) {
      if (!catalog.getModel(modelId)?.targetIds.includes(targetId)) {
        throw new Error(`Model ${modelId} is not available on target: ${targetId}`);
      }
    }
    return { targetId, modelIds };
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
