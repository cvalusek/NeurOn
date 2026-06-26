import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget, DockerContainerTargetConfig } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export class DockerContainerCapacityProvider implements CapacityProvider {
  async installTarget(target: CapacityTarget): Promise<void> {
    const docker = requireDocker(target);
    await this.docker(["pull", docker.image]);
    if (await this.containerExists(docker.containerName)) return;
    await this.docker(["create", ...runArgs(docker), "--name", docker.containerName, docker.image, ...(docker.command ?? [])]);
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const docker = requireDocker(target);
    if (!(await this.containerExists(docker.containerName))) {
      await this.installTarget(target);
    }
    await this.docker(["start", docker.containerName]);
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const docker = requireDocker(target);
    if (!(await this.containerExists(docker.containerName))) return;
    await this.docker(["stop", docker.containerName], false);
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const docker = requireDocker(target);
    const inspect = await this.inspectContainer(docker.containerName);
    if (!inspect) return { observed: "stopped", message: "Container is not installed" };
    const state = inspect.State ?? {};
    if (state.Running) return { observed: "healthy", message: "Container is running", details: { state, image: inspect.Config?.Image } };
    if (state.Status === "exited" || state.Status === "created" || state.Status === "dead") {
      return { observed: "stopped", message: `Container is ${state.Status}`, details: { state, image: inspect.Config?.Image } };
    }
    return { observed: "provisioning", message: `Container is ${state.Status ?? "unknown"}`, details: { state, image: inspect.Config?.Image } };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    await this.ensureTargetOff(target);
  }

  private async containerExists(containerName: string): Promise<boolean> {
    const result = await this.docker(["container", "inspect", containerName], false);
    return result.exitCode === 0;
  }

  private async inspectContainer(containerName: string): Promise<DockerInspect | undefined> {
    const result = await this.docker(["container", "inspect", containerName], false);
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout) as DockerInspect[];
    return parsed[0];
  }

  private async docker(args: string[], rejectOnError = true): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 120_000 });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      if (rejectOnError) throw error;
      const maybe = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: maybe.stdout ?? "", stderr: maybe.stderr ?? "", exitCode: maybe.code ?? 1 };
    }
  }
}

interface DockerInspect {
  Config?: {
    Image?: string;
  };
  State?: {
    Running?: boolean;
    Status?: string;
  };
}

function requireDocker(target: CapacityTarget): DockerContainerTargetConfig {
  if (!target.docker) throw new Error(`Target ${target.id} is missing docker config`);
  return target.docker;
}

function runArgs(config: DockerContainerTargetConfig): string[] {
  return [
    ...(config.ports ?? []).flatMap((port) => ["-p", port]),
    ...(config.volumes ?? []).flatMap((volume) => ["-v", volume]),
    ...Object.entries(config.environment ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    ...(config.gpus ? ["--gpus", config.gpus] : []),
    ...(config.restart ? ["--restart", config.restart] : []),
    ...(config.network ? ["--network", config.network] : []),
    ...(config.extraArgs ?? [])
  ];
}
