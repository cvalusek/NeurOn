import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapacityTarget } from "../domain/types.js";
import { LiteLlmBackendConfigSync } from "../litellm/LiteLlmBackendConfigSync.js";
import { litellmDisplayPrefix, litellmModelName, litellmRoutePrefixes } from "../litellm/modelRouting.js";

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

describe("LiteLlmBackendConfigSync", () => {
  it("upserts one target credential and creates or updates discovered models", async () => {
    process.env.PREFER_G6_API_KEY = "runtime-secret";
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown>; authorization?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined,
        authorization: new Headers(init?.headers).get("authorization") ?? undefined
      });
      if (url.endsWith("/credentials/by_name/neuron/g6.xlarge.general")) return new Response("", { status: 404 });
      if (url.endsWith("/model/info")) {
        return Response.json({
          data: [
            {
              model_name: "old/gemma-4-e2b",
              model_info: {
                id: "existing-gemma",
                managed_by: "neuron",
                neuron_target_id: target.id,
                neuron_runtime_model_id: "gemma-4-e2b"
              }
            },
            {
              model_name: "g6.xlarge.general/removed-model",
              model_info: {
                id: "stale-model",
                managed_by: "neuron",
                neuron_target_id: target.id,
                neuron_runtime_model_id: "removed-model"
              }
            },
            { model_name: "manual/model", model_info: { id: "manual" } }
          ]
        });
      }
      return Response.json({ success: true });
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

    const updateGemma = calls.find((call) => call.url.endsWith("/model/existing-gemma/update"));
    expect(updateGemma?.body).toMatchObject({
      model_name: "g6.xlarge.general/gemma-4-e2b",
      litellm_params: {
        custom_llm_provider: "openai",
        litellm_credential_name: "neuron/g6.xlarge.general",
        model: "gemma-4-e2b"
      },
      model_info: {
        id: "existing-gemma",
        managed_by: "neuron",
        neuron_target_id: target.id,
        neuron_target_display_name: target.displayName,
        neuron_runtime_model_id: "gemma-4-e2b"
      }
    });

    const createQwen = calls.find((call) => call.url.endsWith("/model/new") && call.method === "POST");
    expect(createQwen?.body).toMatchObject({
      model_name: "g6.xlarge.general/qwen-3",
      litellm_params: { custom_llm_provider: "openai", model: "qwen-3" },
      model_info: { neuron_target_display_name: "G6 XL General" }
    });
    expect(calls.some((call) => call.url.endsWith("/model/stale-model/update"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/model/manual/update"))).toBe(false);

    const callCount = calls.length;
    await sync.syncTargetHealthy(target, [{ id: "qwen-3" }, { id: "gemma-4-e2b" }]);
    expect(calls).toHaveLength(callCount);
  });

  it("updates an existing named credential and honors an explicit route prefix", async () => {
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined
      });
      if (url.endsWith("/model/info")) return Response.json({ data: [] });
      return Response.json({ success: true });
    }));
    const configuredTarget: CapacityTarget = {
      ...target,
      trafficModelPrefixes: ["prefer.g6.xlarge.general/"],
      litellm: { credentialName: "neuron/custom-g6" }
    };

    await new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key")
      .syncTargetHealthy(configuredTarget, [{ id: "gemma-4-e2b" }]);

    expect(calls.some((call) => call.url.endsWith("/credentials/neuron/custom-g6") && call.method === "PATCH")).toBe(true);
    expect(calls.find((call) => call.url.endsWith("/credentials/neuron/custom-g6"))?.body).toMatchObject({
      credential_values: { api_key: "noapikey" },
      credential_info: { custom_llm_provider: "openai", provider: "openai" }
    });
    expect(calls.find((call) => call.url.endsWith("/model/new"))?.body).toMatchObject({
      model_name: "prefer.g6.xlarge.general/gemma-4-e2b",
      litellm_params: { litellm_credential_name: "neuron/custom-g6", model: "gemma-4-e2b" }
    });
  });

  it("fails without sending requests when a configured target key is absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sync = new LiteLlmBackendConfigSync("http://litellm.internal:4000", "admin-key");

    await expect(sync.syncTargetHealthy(target, [{ id: "gemma-4-e2b" }])).rejects.toThrow("PREFER_G6_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
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
