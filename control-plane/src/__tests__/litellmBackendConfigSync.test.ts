import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapacityTarget } from "../domain/types.js";
import { LiteLlmBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { litellmDisplayPrefix, litellmModelName, litellmRoutePrefixes } from "../litellm/modelRouting.js";

interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
  authorization?: string;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PREFER_G6_API_KEY;
});

const target: CapacityTarget = {
  id: "g6.xlarge.general",
  displayName: "G6 XL General",
  provider: "aws-ec2",
  modelIds: [],
  apiUrl: "http://10.0.2.15:8080/v1",
  litellm: { apiKeyEnv: "PREFER_G6_API_KEY" }
};

function recordFetch(
  calls: RecordedCall[],
  options: {
    deployments?: unknown[];
    routerSettings?: Record<string, unknown>;
    credentialMissing?: boolean;
  } = {}
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined,
      authorization: new Headers(init?.headers).get("authorization") ?? undefined
    });
    if (url.includes("/credentials/by_name/") && options.credentialMissing) return new Response("", { status: 404 });
    if (url.endsWith("/model/info")) return Response.json({ data: options.deployments ?? [] });
    if (url.endsWith("/router/settings")) return Response.json({ current_values: options.routerSettings ?? {} });
    return Response.json({ success: true });
  });
}

describe("LiteLlmBackendConfigSync", () => {
  it("creates one canonical deployment per runtime model and removes legacy alias deployments", async () => {
    process.env.PREFER_G6_API_KEY = "runtime-secret";
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", recordFetch(calls, {
      credentialMissing: true,
      deployments: [
        {
          model_name: "gemma",
          model_info: {
            id: "legacy-global-gemma",
            managed_by: "neuron",
            neuron_target_id: target.id,
            neuron_runtime_model_id: "gemma-4-e2b",
            neuron_route_name: "gemma",
            neuron_alias_scope: "global"
          }
        },
        {
          model_name: "g6.xlarge.general/gemma",
          model_info: {
            id: "legacy-scoped-gemma",
            managed_by: "neuron",
            neuron_target_id: target.id,
            neuron_runtime_model_id: "gemma-4-e2b",
            neuron_route_name: "g6.xlarge.general/gemma",
            neuron_alias_scope: "target"
          }
        },
        {
          model_name: "neuron-retired/g6.xlarge.general/stale-model",
          model_info: {
            id: "stale-model",
            managed_by: "neuron",
            neuron_target_id: target.id,
            neuron_runtime_model_id: "removed-model",
            neuron_alias_scope: "retired"
          }
        },
        { model_name: "manual/model", model_info: { id: "manual" } }
      ],
      routerSettings: {
        model_group_alias: {
          gemma: "old/gemma",
          "g6.xlarge.general/gemma": "old/gemma",
          manual: "manual/model",
          "operator-object": { model: "manual/model" }
        },
        fallbacks: [
          { gemma: ["old/fallback"] },
          { "manual/model": ["manual/backup"] }
        ]
      }
    }));

    const sync = new LiteLlmBackendConfigSync("http://litellm.internal:4000/", "admin-key");
    await sync.syncTargetHealthy(target, [{ id: "gemma-4-e2b", aliases: ["gemma"] }, { id: "qwen-3" }]);

    const createCredential = calls.find((call) => call.url.endsWith("/credentials") && call.method === "POST");
    expect(createCredential?.body).toEqual({
      credential_name: "neuron/g6.xlarge.general",
      credential_values: { api_base: target.apiUrl, api_key: "runtime-secret" },
      credential_info: {
        custom_llm_provider: "openai",
        provider: "openai",
        managed_by: "neuron",
        neuron_target_id: target.id,
        neuron_target_display_name: target.displayName
      }
    });
    expect(createCredential?.authorization).toBe("Bearer admin-key");

    const createdModels = calls.filter((call) => call.url.endsWith("/model/new"));
    expect(createdModels).toHaveLength(2);
    expect(createdModels.map((call) => call.body?.model_name)).toEqual([
      "g6.xlarge.general/gemma-4-e2b",
      "g6.xlarge.general/qwen-3"
    ]);
    expect(createdModels[0].body).toMatchObject({
      litellm_params: {
        custom_llm_provider: "openai",
        litellm_credential_name: "neuron/g6.xlarge.general",
        model: "gemma-4-e2b"
      },
      model_info: {
        managed_by: "neuron",
        neuron_alias_scope: "canonical",
        neuron_canonical_model_id: "gemma-4-e2b",
        neuron_global_aliases: ["gemma"],
        neuron_scoped_aliases: ["g6.xlarge.general/gemma"]
      }
    });
    expect((createdModels[0].body?.litellm_params as Record<string, unknown>).order).toBeUndefined();

    const configUpdate = calls.find((call) => call.url.endsWith("/config/update"));
    expect(configUpdate?.body).toEqual({
      router_settings: {
        model_group_alias: {
          "g6.xlarge.general/gemma": "g6.xlarge.general/gemma-4-e2b",
          gemma: "g6.xlarge.general/gemma-4-e2b",
          manual: "manual/model",
          "operator-object": { model: "manual/model" },
          "qwen-3": "g6.xlarge.general/qwen-3"
        },
        fallbacks: [{ "manual/model": ["manual/backup"] }]
      }
    });

    const deletedIds = calls
      .filter((call) => call.url.endsWith("/model/delete"))
      .map((call) => call.body?.id)
      .sort();
    expect(deletedIds).toEqual(["legacy-global-gemma", "legacy-scoped-gemma", "stale-model"]);
    expect(calls.some((call) => call.body?.id === "manual")).toBe(false);

    const callCount = calls.length;
    await sync.syncTargetHealthy(target, [{ id: "qwen-3" }, { id: "gemma-4-e2b", aliases: ["gemma"] }]);
    expect(calls).toHaveLength(callCount);
  });

  it("updates an existing canonical deployment and honors configured model IDs and prefixes", async () => {
    const calls: RecordedCall[] = [];
    const configuredTarget: CapacityTarget = {
      ...target,
      trafficModelPrefixes: ["prefer.g6.xlarge.general/"],
      models: [{ id: "large-model", aliases: ["coding"], backendModelIds: ["runtime-large-id"] }],
      litellm: { credentialName: "neuron/custom-g6" }
    };
    vi.stubGlobal("fetch", recordFetch(calls, {
      deployments: [{
        model_name: "prefer.g6.xlarge.general/large-model",
        model_info: {
          id: "duplicate-large",
          managed_by: "neuron",
          neuron_target_id: target.id,
          neuron_runtime_model_id: "runtime-large-id",
          neuron_alias_scope: "canonical",
          neuron_canonical_model_id: "large-model",
          neuron_global_aliases: ["coding"],
          neuron_scoped_aliases: ["prefer.g6.xlarge.general/coding"],
          neuron_alias_priority: 100
        }
      }, {
        model_name: "prefer.g6.xlarge.general/large-model",
        model_info: {
          id: "canonical-large",
          managed_by: "neuron",
          neuron_target_id: target.id,
          neuron_runtime_model_id: "runtime-large-id",
          neuron_alias_scope: "canonical",
          neuron_canonical_model_id: "large-model",
          neuron_global_aliases: ["coding"],
          neuron_scoped_aliases: ["prefer.g6.xlarge.general/coding"],
          neuron_alias_priority: 100
        }
      }]
    }));

    await new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key")
      .syncTargetHealthy(configuredTarget, [{ id: "runtime-large-id" }]);

    expect(calls.some((call) => call.url.endsWith("/credentials/neuron/custom-g6") && call.method === "PATCH")).toBe(true);
    const updated = calls.find((call) => call.url.endsWith("/model/canonical-large/update"));
    expect(updated?.body).toMatchObject({
      model_name: "prefer.g6.xlarge.general/large-model",
      litellm_params: { litellm_credential_name: "neuron/custom-g6", model: "runtime-large-id" },
      model_info: {
        id: "canonical-large",
        neuron_global_aliases: ["coding"],
        neuron_scoped_aliases: ["prefer.g6.xlarge.general/coding"]
      }
    });
    expect(calls.some((call) => call.url.endsWith("/model/new"))).toBe(false);
    expect(calls.find((call) => call.url.endsWith("/model/delete"))?.body).toEqual({ id: "duplicate-large" });
  });

  it("fails without sending requests when a configured target key is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sync = new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key");

    await expect(sync.syncTargetHealthy(target, [{ id: "gemma-4-e2b" }])).rejects.toThrow("PREFER_G6_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("publishes formal model-group aliases and ordered fallbacks, including after restart", async () => {
    const calls: RecordedCall[] = [];
    const primary = { ...target, id: "primary", aliasPriority: 10, litellm: undefined };
    const fallback = { ...target, id: "fallback", aliasPriority: 20, litellm: undefined };
    let deployments: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("/credentials/by_name/")) return new Response("", { status: 404 });
      if (url.endsWith("/model/info")) return Response.json({ data: deployments });
      if (url.endsWith("/router/settings")) return Response.json({ current_values: {} });
      return Response.json({ success: true });
    }));

    const sync = new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key");
    await sync.syncTargetHealthy(primary, [{ id: "runtime-a", aliases: ["coding"] }]);
    deployments = [{
      model_name: "primary/runtime-a",
      model_info: {
        id: "primary-id",
        managed_by: "neuron",
        neuron_target_id: "primary",
        neuron_runtime_model_id: "runtime-a",
        neuron_alias_scope: "canonical",
        neuron_canonical_model_id: "runtime-a",
        neuron_global_aliases: ["coding"],
        neuron_scoped_aliases: ["primary/coding"],
        neuron_alias_priority: 10
      }
    }];
    await sync.syncTargetHealthy(fallback, [{ id: "runtime-b", aliases: ["coding"] }]);

    const latestUpdate = calls.filter((call) => call.url.endsWith("/config/update")).at(-1)?.body;
    expect(latestUpdate).toEqual({
      router_settings: {
        model_group_alias: {
          coding: "primary/runtime-a",
          "fallback/coding": "fallback/runtime-b",
          "primary/coding": "primary/runtime-a"
        },
        fallbacks: [
          { coding: ["fallback/runtime-b"] },
          { "primary/runtime-a": ["fallback/runtime-b"] }
        ]
      }
    });
    expect(calls.filter((call) => call.url.endsWith("/model/new") && call.body?.model_name === "coding")).toHaveLength(0);

    // A fresh synchronizer reconstructs other targets' alias claims from model metadata.
    const restartedCalls: RecordedCall[] = [];
    deployments = [
      deployments[0],
      {
        model_name: "fallback/runtime-b",
        model_info: {
          id: "fallback-id",
          managed_by: "neuron",
          neuron_target_id: "fallback",
          neuron_runtime_model_id: "runtime-b",
          neuron_alias_scope: "canonical",
          neuron_canonical_model_id: "runtime-b",
          neuron_global_aliases: ["coding"],
          neuron_scoped_aliases: ["fallback/coding"],
          neuron_alias_priority: 20
        }
      }
    ];
    vi.stubGlobal("fetch", recordFetch(restartedCalls, { deployments }));
    await new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key")
      .syncTargetHealthy(fallback, [{ id: "runtime-b", aliases: ["coding"] }]);
    expect(restartedCalls.find((call) => call.url.endsWith("/config/update"))?.body).toEqual(latestUpdate);
  });

  it("rejects equal alias priorities and canonical-name conflicts before changing models", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", recordFetch(calls, { credentialMissing: true }));
    const sync = new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key");
    const first = { ...target, id: "first", aliasPriority: 20, litellm: undefined };
    const tied = { ...target, id: "tied", aliasPriority: 20, litellm: undefined };
    await sync.syncTargetHealthy(first, [{ id: "runtime-a", aliases: ["coding"] }]);
    const modelMutationCount = calls.filter((call) => call.url.includes("/model/") && call.url.endsWith("/new")).length;
    await expect(sync.syncTargetHealthy(tied, [{ id: "runtime-b", aliases: ["coding"] }])).rejects.toThrow("priority 20");
    expect(calls.filter((call) => call.url.endsWith("/model/new"))).toHaveLength(modelMutationCount);

    const conflicting = { ...target, id: "other", litellmDisplayPrefix: "", litellm: undefined };
    await expect(sync.syncTargetHealthy(conflicting, [{ id: "first/runtime-a" }])).rejects.toThrow("claimed by multiple target models");
  });

  it("fails closed when LiteLLM does not expose router-settings management", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/model/info")) return Response.json({ data: [] });
      if (url.endsWith("/router/settings")) return new Response("", { status: 404 });
      return Response.json({ success: true });
    }));

    await expect(new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key")
      .syncTargetHealthy({ ...target, litellm: undefined }, [{ id: "runtime-a", aliases: ["coding"] }]))
      .rejects.toThrow("LiteLLM GET /router/settings returned 404");
    expect(calls.some((call) => call.url.endsWith("/model/new"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/model/delete"))).toBe(false);
  });

  it("fails closed on malformed router settings before changing models", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/model/info")) return Response.json({ data: [] });
      if (url.endsWith("/router/settings")) return Response.json({ current_values: { model_group_alias: [] } });
      return Response.json({ success: true });
    }));

    await expect(new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key")
      .syncTargetHealthy({ ...target, litellm: undefined }, [{ id: "runtime-a", aliases: ["coding"] }]))
      .rejects.toThrow("model_group_alias is not an object");
    expect(calls.some((call) => call.url.endsWith("/model/new"))).toBe(false);
  });

  it("refuses to overwrite an operator-owned alias collision", async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", recordFetch(calls, {
      routerSettings: { model_group_alias: { coding: "operator/model" } }
    }));

    await expect(new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key")
      .syncTargetHealthy({ ...target, litellm: undefined }, [{ id: "runtime-a", aliases: ["coding"] }]))
      .rejects.toThrow("already operator-managed");
    expect(calls.some((call) => call.url.endsWith("/model/new"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/config/update"))).toBe(false);
  });
});

describe("LiteLLM model routing", () => {
  it("defaults prefixes and model names to the stable target ID", () => {
    const unconfigured = { ...target, litellm: undefined, trafficModelPrefixes: undefined };
    expect(litellmRoutePrefixes(unconfigured)).toEqual(["g6.xlarge.general/"]);
    expect(litellmDisplayPrefix(unconfigured)).toBe("g6.xlarge.general/");
    expect(litellmModelName(unconfigured, "gemma-4-e2b")).toBe("g6.xlarge.general/gemma-4-e2b");
  });

  it("preserves an intentionally empty display prefix", () => {
    const unprefixed = { ...target, litellmDisplayPrefix: "" };
    expect(litellmModelName(unprefixed, "gemma-4-e2b")).toBe("gemma-4-e2b");
  });
});
