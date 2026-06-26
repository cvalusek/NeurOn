import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapacityProvider } from "../domain/interfaces.js";
import type { CapacityProviderStatus, CapacityTarget } from "../domain/types.js";

const execFileAsync = promisify(execFile);

export class DockerComposeCapacityProvider implements CapacityProvider {
  async installTarget(target: CapacityTarget): Promise<void> {
    const docker = requireDockerCompose(target);
    await this.compose(target, ["pull", docker.serviceName]);
    await this.compose(target, ["create", "--no-start", docker.serviceName], false);
  }

  async ensureTargetOn(target: CapacityTarget): Promise<void> {
    const docker = requireDockerCompose(target);
    await this.compose(target, ["up", "-d", "--no-build", docker.serviceName]);
  }

  async ensureTargetOff(target: CapacityTarget): Promise<void> {
    const docker = requireDockerCompose(target);
    await this.compose(target, ["stop", docker.serviceName]);
  }

  async getTargetStatus(target: CapacityTarget): Promise<CapacityProviderStatus> {
    const docker = requireDockerCompose(target);
    const { stdout } = await this.compose(target, ["ps", "--all", "--format", "json", docker.serviceName], false);
    const services = parseComposePs(stdout);
    const service = services.find((item) => item.Service === docker.serviceName || item.Name?.includes(docker.serviceName));
    if (!service) return { observed: "stopped", message: "Compose service is not created" };
    if (service.State === "running") {
      return { observed: "healthy", message: "Compose service is running", details: service };
    }
    if (service.State === "exited" || service.State === "stopped") {
      return { observed: "stopped", message: "Compose service is stopped", details: service };
    }
    return { observed: "provisioning", message: `Compose service state: ${service.State ?? "unknown"}`, details: service };
  }

  async forceStopTarget(target: CapacityTarget): Promise<void> {
    const docker = requireDockerCompose(target);
    await this.compose(target, ["stop", docker.serviceName]);
  }

  private async compose(target: CapacityTarget, args: string[], rejectOnError = true): Promise<{ stdout: string; stderr: string }> {
    const docker = requireDockerCompose(target);
    const composeArgs = ["compose"];
    if (docker.projectName) composeArgs.push("-p", docker.projectName);
    for (const composeFile of docker.composeFiles ?? (docker.composeFile ? [docker.composeFile] : [])) {
      composeArgs.push("-f", composeFile);
    }
    for (const profile of docker.profiles ?? []) {
      composeArgs.push("--profile", profile);
    }
    composeArgs.push(...args);
    try {
      return await execFileAsync("docker", composeArgs, { cwd: docker.projectDirectory, timeout: 120_000 });
    } catch (error) {
      if (rejectOnError) throw error;
      const maybe = error as { stdout?: string; stderr?: string };
      return { stdout: maybe.stdout ?? "", stderr: maybe.stderr ?? "" };
    }
  }
}

function requireDockerCompose(target: CapacityTarget) {
  if (!target.dockerCompose) throw new Error(`Target ${target.id} is missing dockerCompose config`);
  return target.dockerCompose;
}

function parseComposePs(stdout: string): Array<Record<string, string>> {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as Record<string, string> | Array<Record<string, string>>;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, string>];
        } catch {
          return [];
        }
      });
  }
}
