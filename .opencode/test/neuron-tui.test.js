import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const logicUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "neuron-tui", "logic.js")
).href;

const {
  isProviderAllowed,
  matchModelEntry,
  modelCandidates,
  parseAllowedProviders,
  resolveTargetForModel,
  pickReservation,
  stateLevel,
  formatCountdown,
  formatClock,
  summarizeNeuron
} = await import(logicUrl);

describe("parseAllowedProviders", () => {
  it("parses comma-separated providers trimmed and lowercased", () => {
    assert.deepEqual(parseAllowedProviders("litellm, openai"), ["litellm", "openai"]);
    assert.deepEqual(parseAllowedProviders("  LiteLLM  "), ["litellm"]);
  });

  it("returns an empty list for empty or missing values", () => {
    assert.deepEqual(parseAllowedProviders(""), []);
    assert.deepEqual(parseAllowedProviders(undefined), []);
    assert.deepEqual(parseAllowedProviders(" , ,"), []);
  });
});

describe("isProviderAllowed", () => {
  it("allows everything when the filter is empty", () => {
    assert.equal(isProviderAllowed([], "homellm", "qwen3.8-27b-q6"), true);
    assert.equal(isProviderAllowed(undefined, undefined, undefined), true);
  });

  it("matches the provider id case-insensitively", () => {
    assert.equal(isProviderAllowed(["litellm"], "LiteLLM", "gemma-4"), true);
    assert.equal(isProviderAllowed(["litellm"], "homellm", "gemma-4"), false);
  });

  it("falls back to a provider-prefixed model string without a provider id", () => {
    assert.equal(isProviderAllowed(["litellm"], undefined, "litellm/gemma-4"), true);
    assert.equal(isProviderAllowed(["litellm"], undefined, "homellm/gemma-4"), false);
    assert.equal(isProviderAllowed(["litellm"], undefined, "gemma-4"), false);
  });
});

// Fixed reference time so every assertion is deterministic.
const NOW = 1_700_000_000_000;

function iso(msFromNow) {
  return new Date(NOW + msFromNow).toISOString();
}

describe("resolveTargetForModel", () => {
  const models = [
    { id: "gemma-4-26b-a4b", aliases: ["gemma-4", "Gemma4"], targetIds: ["t1"] },
    { id: "other-model", aliases: ["oth"], targetIds: ["t2"] }
  ];

  it("matches the model id directly", () => {
    assert.equal(resolveTargetForModel(models, "gemma-4-26b-a4b"), "t1");
  });

  it("matches aliases case-insensitively", () => {
    assert.equal(resolveTargetForModel(models, "GEMMA-4"), "t1");
    assert.equal(resolveTargetForModel(models, "OTH"), "t2");
  });

  it("returns the first targetId when several exist", () => {
    assert.equal(
      resolveTargetForModel([{ id: "m", aliases: [], targetIds: ["a", "b"] }], "m"),
      "a"
    );
  });

  it("returns undefined when no model matches", () => {
    assert.equal(resolveTargetForModel(models, "missing"), undefined);
    assert.equal(resolveTargetForModel([], "gemma-4"), undefined);
    assert.equal(resolveTargetForModel(models, undefined), undefined);
  });

  it("prefers the target named by the litellm route prefix", () => {
    const live = [
      {
        id: "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL",
        aliases: ["unsloth/Qwen3.5-9B-GGUF:Q4_K_XL", "qwen-3.5", "qwen-3.5-9b"],
        targetIds: ["g7e.2xlarge.general", "g6.xlarge.general", "g6.xlarge.qwen-9b"],
      },
    ];
    assert.equal(
      resolveTargetForModel(
        live,
        "g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"
      ),
      "g6.xlarge.qwen-9b"
    );
  });

  it("resolves a bare runtime model name without a prefix to the first target", () => {
    const live = [
      {
        id: "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL",
        aliases: ["qwen-3.5"],
        runtimeModelIds: ["unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"],
        targetIds: ["g6.xlarge.qwen-9b", "g7e.2xlarge.general"],
      },
    ];
    assert.equal(
      resolveTargetForModel(live, "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"),
      "g6.xlarge.qwen-9b"
    );
  });

  it("matches via runtimeModelIds when id and aliases do not cover the name", () => {
    const live = [
      {
        id: "internal-registry-name",
        aliases: [],
        runtimeModelIds: ["unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"],
        targetIds: ["t-r"],
      },
    ];
    assert.equal(
      resolveTargetForModel(live, "t-x/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"),
      "t-r"
    );
  });
});

describe("matchModelEntry", () => {
  const live = [
    {
      id: "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL",
      aliases: ["qwen-3.5", "qwen-3.5-9b"],
      backendModelIds: [],
      runtimeModelIds: ["unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"],
      targetIds: ["g6.xlarge.qwen-9b"],
    },
  ];

  it("matches a full litellm route name via its suffix", () => {
    const entry = matchModelEntry(live, "g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL");
    assert.equal(entry?.id, "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL");
  });

  it("matches aliases case-insensitively", () => {
    assert.equal(matchModelEntry(live, "QWEN-3.5")?.id, "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL");
  });

  it("returns undefined for unknown models and empty input", () => {
    assert.equal(matchModelEntry(live, "not-a-model"), undefined);
    assert.equal(matchModelEntry([], "qwen-3.5"), undefined);
    assert.equal(matchModelEntry(live, undefined), undefined);
  });

  it("builds longest-first suffix candidates", () => {
    assert.deepEqual(
      modelCandidates("g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"),
      [
        "g6.xlarge.qwen-9b/unsloth/qwen3.5-9b-gguf:q4_k_xl",
        "unsloth/qwen3.5-9b-gguf:q4_k_xl",
        "qwen3.5-9b-gguf:q4_k_xl",
      ]
    );
  });
});

describe("pickReservation", () => {
  function reservation(reservationId, modelIds, targets, msFromNow) {
    return {
      reservationId,
      modelIds,
      targets,
      expiresAt: iso(msFromNow)
    };
  }

  it("matches modelIds against the session model id and aliases case-insensitively", () => {
    const r = reservation("r1", ["GEMMA-4"], [{ id: "t1" }], 100000);
    const picked = pickReservation([r], "gemma-4-26b-a4b", ["gemma-4"], undefined);
    assert.equal(picked?.reservationId, "r1");
  });

  it("prefers model-intersection matches over other reservations", () => {
    const foreign = reservation("r-foreign", ["other"], [{ id: "t1" }], 1000);
    const match = reservation("r-match", ["gemma-4"], [{ id: "t1" }], 999999);
    const picked = pickReservation([foreign, match], "gemma-4", [], undefined);
    assert.equal(picked?.reservationId, "r-match");
  });

  it("falls back to target membership when no reservation matches the model", () => {
    const other = reservation("r-other", ["a"], [{ id: "t9" }], 1000);
    const mine = reservation("r-mine", ["b"], [{ id: "t1" }], 5000);
    const picked = pickReservation([other, mine], "gemma-4", [], "t1");
    assert.equal(picked?.reservationId, "r-mine");
  });

  it("picks the nearest expiresAt when several reservations match", () => {
    const far = reservation("r-far", ["gemma-4"], [{ id: "t1" }], 600000);
    const near = reservation("r-near", ["gemma-4"], [{ id: "t1" }], 60000);
    const picked = pickReservation([far, near], "gemma-4", [], undefined);
    assert.equal(picked?.reservationId, "r-near");
  });

  it("filters by target before applying the nearest-expiry rule", () => {
    const t1far = reservation("r-t1far", ["gemma-4"], [{ id: "t1" }], 30000);
    const t2near = reservation("r-t2near", ["gemma-4"], [{ id: "t2" }], 1000);
    const picked = pickReservation([t1far, t2near], "gemma-4", [], "t1");
    assert.equal(picked?.reservationId, "r-t1far");
  });

  it("returns undefined for empty input", () => {
    assert.equal(pickReservation([], "gemma-4", [], "t1"), undefined);
    assert.equal(pickReservation(undefined, "gemma-4", [], "t1"), undefined);
  });

  it("matches via the catalog entry's runtime model ids (litellm route names)", () => {
    const mine = {
      reservationId: "r-live",
      modelIds: ["unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"],
      targets: [{ id: "g6.xlarge.qwen-9b" }],
      expiresAt: iso(600000)
    };
    const foreign = {
      reservationId: "r-foreign",
      modelIds: ["unsloth/Other-GGUF:Q4_K_XL"],
      targets: [{ id: "g6.xlarge.qwen-9b" }],
      expiresAt: iso(1000)
    };
    const picked = pickReservation(
      [foreign, mine],
      "g6.xlarge.qwen-9b/unsloth/Qwen3.5-9B-GGUF:Q4_K_XL",
      [
        "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL",
        "qwen-3.5",
        "qwen-3.5-9b",
        "unsloth/Qwen3.5-9B-GGUF:Q4_K_XL"
      ],
      "g6.xlarge.qwen-9b"
    );
    assert.equal(picked?.reservationId, "r-live");
  });
});

describe("stateLevel", () => {
  it("maps healthy to ok", () => {
    assert.equal(stateLevel("healthy"), "ok");
  });

  it("maps in-flight states to warn", () => {
    for (const s of ["starting", "stopping", "warming", "pending"]) {
      assert.equal(stateLevel(s), "warn");
    }
  });

  it("maps dead states to bad", () => {
    for (const s of ["stopped", "cold", "offline", "error", "failed"]) {
      assert.equal(stateLevel(s), "bad");
    }
  });

  it("maps anything else (incl. undefined) to unknown", () => {
    assert.equal(stateLevel("unheard-of"), "unknown");
    assert.equal(stateLevel(undefined), "unknown");
  });
});

describe("formatCountdown", () => {
  it("formats mm:ss under an hour", () => {
    assert.equal(formatCountdown(75000), "1:15");
    assert.equal(formatCountdown(59999), "0:59");
    assert.equal(formatCountdown(3599999), "59:59");
  });

  it("formats h:mm:ss at or over an hour", () => {
    assert.equal(formatCountdown(3600000), "1:00:00");
    assert.equal(formatCountdown(3675000), "1:01:15");
  });

  it("floors fractional seconds", () => {
    assert.equal(formatCountdown(75999), "1:15");
  });

  it("returns 0:00 for negative or NaN input", () => {
    assert.equal(formatCountdown(-1), "0:00");
    assert.equal(formatCountdown(Number.NaN), "0:00");
  });
});

describe("formatClock", () => {
  it("formats a valid ISO timestamp as 12h local h:MM:SS AM/PM", () => {
    const input = "2026-08-29T14:32:05.000Z";
    const actual = formatClock(input);
    assert.match(actual, /^\d{1,2}:\d{2}:\d{2} (AM|PM)$/);
    // Expected built from the same Date parts — deterministic on any TZ.
    const d = new Date(input);
    const h24 = d.getHours();
    const meridiem = h24 < 12 ? "AM" : "PM";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const expected = `${h12}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")} ${meridiem}`;
    assert.equal(actual, expected);
  });

  it("maps midnight and noon to 12 AM / 12 PM", () => {
    // Build local midnight and noon ISO strings, then verify the mapping.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    assert.equal(formatClock(midnight.toISOString()), "12:00:00 AM");
    const noon = new Date();
    noon.setHours(12, 30, 45, 0);
    assert.equal(formatClock(noon.toISOString()), "12:30:45 PM");
  });

  it("returns '-' for invalid input", () => {
    assert.equal(formatClock("not-a-date"), "-");
    assert.equal(formatClock(""), "-");
    assert.equal(formatClock(undefined), "-");
  });
});

function baseInput(overrides = {}) {
  return {
    apiOk: true,
    stale: false,
    modelId: "gemma-4",
    providerId: "litellm",
    isNeuronModel: true,
    targetId: "t1",
    targetDisplayName: "T1",
    targetProvider: "aws-ecs",
    targetObserved: "healthy",
    activeUsers: 1,
    reservation: { reservationId: "r1", expiresAt: iso(700000), keepaliveMinutes: 2 },
    now: NOW,
    sessionShortId: "ses_01ABCDEF",
    sessionBusy: true,
    lastRefreshedAt: NOW - 3000,
    ...overrides
  };
}

function rowOf(summary, label) {
  return summary.rows.find((r) => r.label === label);
}

describe("summarizeNeuron", () => {
  it("reports an unreachable API with a warn level", () => {
    const s = summarizeNeuron(baseInput({ apiOk: false }));
    assert.equal(s.collapsed, "! unreachable");
    assert.equal(s.level, "warn");
    assert.equal(rowOf(s, "api")?.value, "unreachable");
  });

  it("reports non-NeurOn models as not managed", () => {
    const s = summarizeNeuron(baseInput({ isNeuronModel: false }));
    assert.equal(s.collapsed, "○ not managed");
    assert.equal(s.level, "unknown");
    const s2 = summarizeNeuron(baseInput({ isNeuronModel: false, modelId: undefined }));
    assert.equal(s2.collapsed, "○ not managed");
  });

  it("shows state and countdown for a healthy target with a reservation", () => {
    const s = summarizeNeuron(baseInput());
    // Model name comes from the control-plane displayName (baseInput: "T1").
    assert.equal(s.collapsed, "● healthy · 11:40 left");
    assert.equal(s.level, "ok");
    assert.equal(rowOf(s, "model")?.value, "T1 (litellm/gemma-4)");
    const expires = rowOf(s, "expires");
    assert.ok(expires);
    assert.equal(expires.tone, "accent");
    // Wall clock plus a live countdown, e.g. `2:32:05 PM · 11:40 left`.
    assert.match(expires.value, /^\d{1,2}:\d{2}:\d{2} (AM|PM) · \d+:\d{2} left$/);
  });

  it("warns on expires when under 2 minutes remain", () => {
    const s = summarizeNeuron(
      baseInput({ reservation: { reservationId: "r1", expiresAt: iso(90000), keepaliveMinutes: 2 } })
    );
    assert.equal(rowOf(s, "expires")?.tone, "warn");
    assert.match(s.collapsed, /1:30 left/);
  });

  it("flags expires as bad when under 30 seconds remain", () => {
    const s = summarizeNeuron(
      baseInput({ reservation: { reservationId: "r1", expiresAt: iso(10000) } })
    );
    assert.equal(rowOf(s, "expires")?.tone, "bad");
  });

  it("shows 'no reservation' when the target has none", () => {
    const s = summarizeNeuron(baseInput({ reservation: undefined }));
    assert.equal(s.collapsed, "● healthy · no reservation");
    assert.equal(rowOf(s, "reservation")?.value, "none");
    assert.equal(rowOf(s, "expires"), undefined);
  });

  it("falls back to the opencode model id when no displayName is available", () => {
    const s = summarizeNeuron(baseInput({ targetDisplayName: undefined }));
    assert.equal(s.collapsed, "● healthy · 11:40 left");
    assert.equal(rowOf(s, "model")?.value, "litellm/gemma-4");
  });

  it("reports a missing target as unknown", () => {
    const s = summarizeNeuron(baseInput({ targetId: undefined, targetObserved: undefined }));
    assert.equal(s.collapsed, "● unknown");
    assert.equal(s.level, "unknown");
  });

  it("appends (stale) to the collapsed line and api row when stale", () => {
    const s = summarizeNeuron(baseInput({ stale: true }));
    assert.ok(s.collapsed.endsWith(" (stale)"));
    assert.equal(rowOf(s, "api")?.value, "ok · refreshed 3s ago · stale");
  });

  it("renders rate and cost rows from the reservation costEstimate", () => {
    const s = summarizeNeuron(
      baseInput({
        reservation: {
          reservationId: "r1",
          expiresAt: iso(700000),
          keepaliveMinutes: 2,
        },
        costEstimate: {
          estimatedCostUsd: 0.080483,
          currency: "USD",
          projectedRemainingCostUsd: 0.461068,
          projectedTotalCostUsd: 0.541551,
          estimatedHourlyCostUsd: 0.8048,
        },
      })
    );
    assert.equal(rowOf(s, "rate")?.value, "$0.80 /hr");
    assert.equal(rowOf(s, "cost")?.value, "$0.46 left · $0.54 total");
  });

  it("omits cost rows without a reservation or costEstimate", () => {
    const noRes = summarizeNeuron(baseInput({ reservation: undefined }));
    assert.equal(rowOf(noRes, "rate"), undefined);
    assert.equal(rowOf(noRes, "cost"), undefined);
    // Reservation exists but no costEstimate (baseInput has none).
    const noEst = summarizeNeuron(baseInput());
    assert.equal(rowOf(noEst, "rate"), undefined);
    assert.equal(rowOf(noEst, "cost"), undefined);
  });

  it("formats non-USD currency codes explicitly", () => {
    const s = summarizeNeuron(
      baseInput({
        costEstimate: { currency: "EUR", estimatedHourlyCostUsd: 0.8, projectedRemainingCostUsd: 0.4 },
      })
    );
    assert.equal(rowOf(s, "rate")?.value, "0.80 EUR /hr");
    assert.equal(rowOf(s, "cost")?.value, "0.40 EUR left");
  });

  it("renders session, keepalive and target rows", () => {
    const s = summarizeNeuron(baseInput());
    assert.equal(rowOf(s, "session")?.value, "ses_01ABCDEF busy");
    assert.equal(rowOf(s, "keepalive")?.value, "2 min");
    assert.equal(rowOf(s, "target")?.value, "aws-ecs · users: 1");
    assert.equal(rowOf(s, "target state")?.value, "healthy");
  });

  it("unmanaged model + foreign reservation → no detail rows, muted note", () => {
    // The reported bug: a reservation active for ANOTHER (managed) model
    // must not render its detail rows under the unmanaged session model.
    const s = summarizeNeuron(
      baseInput({
        isNeuronModel: false,
        reservation: { reservationId: "r-foreign", expiresAt: iso(700000), keepaliveMinutes: 10 },
        costEstimate: {
          estimatedHourlyCostUsd: 0.8,
          currency: "USD",
          projectedRemainingCostUsd: 0.46,
          projectedTotalCostUsd: 0.54,
        },
        otherActiveCount: 1,
      })
    );
    for (const label of ["expires", "keepalive", "rate", "cost"]) {
      assert.equal(rowOf(s, label), undefined, `unexpected row: ${label}`);
    }
    assert.equal(rowOf(s, "target state"), undefined);
    const res = rowOf(s, "reservation");
    assert.equal(res?.value, "none for this model (1 active for other model)");
    assert.equal(res?.tone, "muted");
    const model = rowOf(s, "model");
    assert.ok(model.value.endsWith(" · not managed"), `model row: ${model.value}`);
    assert.equal(model.tone, "muted");
    // Collapsed header carries status only — no model name.
    assert.equal(s.collapsed, "○ not managed");
  });

  it("unmanaged model + no other active reservations → bare note", () => {
    const s = summarizeNeuron(baseInput({ isNeuronModel: false, reservation: undefined }));
    const res = rowOf(s, "reservation");
    assert.equal(res?.value, "none for this model");
    assert.equal(res?.tone, "muted");
    assert.equal(rowOf(s, "expires"), undefined);
  });

  it("unmanaged model + 2 other active reservations → plural note", () => {
    const s = summarizeNeuron(
      baseInput({ isNeuronModel: false, reservation: undefined, otherActiveCount: 2 })
    );
    assert.equal(rowOf(s, "reservation")?.value, "none for this model (2 active for other models)");
  });

  it("unmanaged model + reservation passed explicitly (defensive) → still no detail rows", () => {
    // Even if a caller passes a reservation while isNeuronModel is false,
    // the detail rows must not render and the reservation row must show
    // the note — not the foreign id.
    const s = summarizeNeuron(
      baseInput({
        isNeuronModel: false,
        reservation: { reservationId: "r-foreign", expiresAt: iso(700000), keepaliveMinutes: 10 },
        otherActiveCount: 1,
      })
    );
    assert.equal(rowOf(s, "expires"), undefined);
    assert.equal(rowOf(s, "keepalive"), undefined);
    assert.equal(rowOf(s, "rate"), undefined);
    assert.equal(rowOf(s, "cost"), undefined);
    const res = rowOf(s, "reservation");
    assert.equal(res?.value, "none for this model (1 active for other model)");
    assert.ok(!res.value.includes("r-foreign"));
  });

  it("managed model + own reservation → rows unchanged (no not-managed marker)", () => {
    const s = summarizeNeuron(baseInput());
    const model = rowOf(s, "model");
    assert.equal(model.value, "T1 (litellm/gemma-4)");
    assert.equal(model.tone, undefined);
    assert.equal(rowOf(s, "target state")?.value, "healthy");
    assert.equal(rowOf(s, "reservation")?.value, "r1");
    assert.ok(rowOf(s, "expires"));
    assert.equal(rowOf(s, "keepalive")?.value, "2 min");
    // otherActiveCount must not alter the managed display at all.
    const s2 = summarizeNeuron(baseInput({ otherActiveCount: 3 }));
    assert.equal(rowOf(s2, "model")?.value, "T1 (litellm/gemma-4)");
    assert.equal(rowOf(s2, "reservation")?.value, "r1");
  });
});
