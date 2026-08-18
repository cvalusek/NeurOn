import { describe, expect, it } from "vitest";
import type { CapacityTarget } from "../domain/types.js";
import { directRuntimeHostUrl } from "../utils/runtimeUrl.js";

const target: CapacityTarget = {
  id: "t1",
  displayName: "T1",
  provider: "docker",
  modelIds: []
};

describe("directRuntimeHostUrl", () => {
  it("links to the model-host root without carrying API query data", () => {
    expect(directRuntimeHostUrl({ ...target, apiUrl: "https://runtime.example.test/models/v1?token=private#fragment" }))
      .toBe("https://runtime.example.test/models/");
  });

  it("uses the target LiteLLM runtime base when no API URL is set", () => {
    expect(directRuntimeHostUrl({ ...target, litellm: { apiBaseUrl: "http://runtime.internal:8080/v1" } }))
      .toBe("http://runtime.internal:8080/");
  });

  it("rejects non-HTTP and credential-bearing links", () => {
    expect(directRuntimeHostUrl({ ...target, apiUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(directRuntimeHostUrl({ ...target, apiUrl: "https://user:secret@runtime.example.test/v1" })).toBeUndefined();
  });
});
