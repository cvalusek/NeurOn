import { describe, expect, it } from "vitest";
import { dockerRunArgs } from "../capacity/DockerContainerCapacityProvider.js";

describe("Docker container provider", () => {
  it("creates containers with all GPUs by default", () => {
    expect(dockerRunArgs({ containerName: "prefer" })).toEqual(expect.arrayContaining(["--gpus", "all"]));
  });

  it("allows explicit GPU config to override the default", () => {
    expect(dockerRunArgs({ containerName: "prefer", gpus: "device=0" })).toEqual(expect.arrayContaining(["--gpus", "device=0"]));
  });
});
