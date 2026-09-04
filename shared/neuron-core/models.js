// ── Model → target matching ───────────────────────────────
// Pure model/provider normalization and registry resolution against the
// NeurOn /api/models + capacity targets. No state, no I/O, no logging.

export function splitProvider(modelId) {
  const slash = modelId.indexOf("/");
  if (slash > 0 && slash < modelId.length - 1) {
    return { provider: modelId.slice(0, slash), bareModelId: modelId.slice(slash + 1) };
  }
  return { provider: undefined, bareModelId: modelId };
}

export function canonicalizeModel(provider, modelId) {
  const id = modelId ?? "";
  let finalProvider = provider;
  let bareModelId;
  if (provider) {
    // Provider is given explicitly. The modelId may be either "targetId/alias"
    // (provider prefix absent) or "provider/targetId/alias" (prefix present).
    // Preserve the targetId/alias portion — do NOT re-split it as provider/model,
    // otherwise the targetId gets mistaken for a provider and the hint is lost
    // (which then makes matchLiteLlmModel pick an arbitrary host target).
    if (id.startsWith(provider + "/")) {
      bareModelId = id.slice(provider.length + 1);
    } else {
      bareModelId = id;
    }
  } else {
    const split = splitProvider(id);
    finalProvider = split.provider;
    bareModelId = split.bareModelId;
  }
  const fullModel = finalProvider ? `${finalProvider}/${bareModelId}` : bareModelId;
  return { provider: finalProvider, bareModelId, fullModel };
}

function resolveProviderFallback(fallbackTargets, bareModelId, strictProviderMatch, targetIdHint) {
  // Prefer the target explicitly named in the config (provider/targetId/model form)
  if (targetIdHint) {
    const hinted = fallbackTargets.find((t) => t.id === targetIdHint);
    if (hinted) return { targetIds: [hinted.id] };
  }
  if (!strictProviderMatch && fallbackTargets.length === 1) {
    return { targetIds: [fallbackTargets[0].id] };
  }
  if (!strictProviderMatch && fallbackTargets.length > 1) {
    const providers = [...new Set(fallbackTargets.map((t) => t.provider?.toLowerCase()).filter(Boolean))];
    if (providers.length === 1) {
      return { targetIds: [fallbackTargets[0].id] };
    }
    if (providers.length === 0) {
      return { error: 'provider_mapping_error', detail: `Model "${bareModelId}" has multiple NeurOn targets with missing provider metadata.` };
    }
    return { error: 'provider_mapping_error', detail: `Model "${bareModelId}" is on multiple NeurOn providers (${providers.join(", ")}). Configure provider mapping or use strict provider labels.` };
  }
  return null;
}

export function matchLiteLlmModel(targets, models, bareModelId, provider, strictProviderMatch = false) {
  const modelByLookup = buildModelLookup(models);

  // Derive candidate model-name keys: the full id, then each suffix after a "/".
  // e.g. "g6e.xlarge.qwen-27b/qwen-3.8-27b" -> ["g6e.xlarge.qwen-27b/qwen-3.8-27b", "qwen-3.8-27b"]
  // This lets a config model id match either the API model id/alias OR a target prefix.
  const segments = bareModelId.split("/");
  const candidates = [];
  for (let i = 0; i < segments.length; i++) {
    candidates.push(segments.slice(i).join("/"));
  }
  // When the id carries a target prefix (provider/targetId/model), the leading
  // segment is the NeurOn target we should prefer.
  const targetIdHint = segments.length > 1 ? segments[0] : undefined;

  // ── Pass 1: Model lookup with provider/target preference ─────────
  let model = null;
  let matchedCandidate = null;
  for (const c of candidates) {
    const m = modelByLookup.get(c);
    if (m && m.targetIds?.length) {
      model = m;
      matchedCandidate = c;
      break;
    }
  }

  if (model) {
    // Prefer the target whose id equals the config's targetId hint
    if (targetIdHint) {
      const exact = targets.find((t) => model.targetIds.includes(t.id) && t.id === targetIdHint);
      if (exact) return { modelIds: [model.id], targetIds: [exact.id] };
    }
    if (provider) {
      const pLower = provider.toLowerCase();
      const providerFallbackTargets = [];
      for (const target of targets) {
        if (model.targetIds.includes(target.id) &&
            target.provider?.toLowerCase() === pLower) {
          return { modelIds: [model.id], targetIds: [target.id] };
        }
        if (model.targetIds.includes(target.id)) {
          providerFallbackTargets.push(target);
        }
      }
      const fallback = resolveProviderFallback(providerFallbackTargets, matchedCandidate, strictProviderMatch, targetIdHint);
      if (fallback) {
        if (fallback.error) return fallback;
        return { modelIds: [model.id], targetIds: fallback.targetIds };
      }
      return { error: 'provider_mapping_error', detail: `Model "${matchedCandidate}" not found on provider "${provider}".` };
    }
    // No provider — collect providers hosting this model for ambiguity check
    const pass1Providers = new Set();
    let pass1Primary = null;
    for (const target of targets) {
      if (model.targetIds.includes(target.id)) {
        if (!pass1Primary) pass1Primary = target;
        if (target.provider) pass1Providers.add(target.provider.toLowerCase());
      }
    }
    if (pass1Providers.size > 1) {
      return { error: `ambiguous_model_mapping`, detail: `Model "${matchedCandidate}" is available on providers: ${[...pass1Providers].join(", ")}. Specify provider explicitly.` };
    }
    if (pass1Primary) {
      return { modelIds: [model.id], targetIds: [pass1Primary.id] };
    }
  }

  // ── Pass 2: Direct target modelIds match (try each candidate) ────
  let primaryMatch = null;
  const providerFallbackMatches = [];
  let altProviders = new Set();

  for (const target of targets) {
    if (!candidates.some((c) => target.modelIds?.includes(c))) continue;

    if (provider) {
      const tProv = target.provider?.toLowerCase();
      if (tProv === provider.toLowerCase()) {
        return { modelIds: [matchedCandidate ?? bareModelId], targetIds: [target.id] };
      }
      providerFallbackMatches.push(target);
      if (tProv) altProviders.add(tProv);
    } else {
      if (!primaryMatch) primaryMatch = target;
      if (target.provider) {
        altProviders.add(target.provider.toLowerCase());
      }
    }
  }

  // Provider was given but no exact match found
  if (provider) {
    const fallback = resolveProviderFallback(providerFallbackMatches, matchedCandidate ?? bareModelId, strictProviderMatch, targetIdHint);
    if (fallback) {
      if (fallback.error) return fallback;
      return { modelIds: [matchedCandidate ?? bareModelId], targetIds: fallback.targetIds };
    }
    return { error: 'provider_mapping_error', detail: `Model "${bareModelId}" not found on provider "${provider}". Available providers: ${[...altProviders].join(", ")}.` };
  }

  // No provider specified but multiple providers host this model — ambiguous
  if (!provider && altProviders.size > 1) {
    return { error: `ambiguous_model_mapping`, detail: `Model "${bareModelId}" is available on providers: ${[...altProviders].join(", ")}. Specify provider explicitly.` };
  }

  if (primaryMatch) {
    return { modelIds: [matchedCandidate ?? bareModelId], targetIds: [primaryMatch.id] };
  }

  // ── Pass 3: Direct target-id match (config may name the target itself) ──
  const directTarget = targets.find((t) => t.id === bareModelId);
  if (directTarget) {
    const modelId = directTarget.modelIds?.[0];
    if (modelId) return { modelIds: [modelId], targetIds: [directTarget.id] };
    return { targetIds: [directTarget.id] };
  }

  return undefined;
}

export function buildModelLookup(models) {
  const lookup = new Map();
  for (const model of models) {
    for (const id of [
      model.id,
      ...(model.aliases ?? []),
      ...(model.backendModelIds ?? []),
      ...(model.runtimeModelIds ?? [])
    ]) {
      if (id) lookup.set(id, model);
    }
  }
  return lookup;
}

export function findTargetStatus(targets, targetId) {
  for (const t of targets)
    if (t.id === targetId) return t;
  return undefined;
}
