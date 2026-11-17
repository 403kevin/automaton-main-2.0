import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";

const exec = promisify(execFile);

export interface AgentRuntime {
  start(spec: { id: string; token: string; workspace: string }): Promise<{ containerId: string }>;
  stop(id: string): Promise<void>;
}

export type BootFn = (spec: { id: string; token: string; workspace: string }, signal: AbortSignal) => void;

export class ProcessRuntime implements AgentRuntime {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly boot: BootFn) {}

  async start(spec: { id: string; token: string; workspace: string }): Promise<{ containerId: string }> {
    await this.stop(spec.id);
    const controller = new AbortController();
    this.controllers.set(spec.id, controller);
    this.boot(spec, controller.signal);
    return { containerId: `process:${spec.id}` };
  }

  async stop(id: string): Promise<void> {
    const controller = this.controllers.get(id);
    if (!controller) return;
    controller.abort();
    this.controllers.delete(id);
  }
}

export class FakeRuntime implements AgentRuntime {
  readonly started: string[] = [];
  readonly stopped: string[] = [];

  async start(spec: { id: string }): Promise<{ containerId: string }> {
    this.started.push(spec.id);
    return { containerId: `fake:${spec.id}` };
  }

  async stop(id: string): Promise<void> {
    this.stopped.push(id);
  }
}

export class UnavailableRuntime implements AgentRuntime {
  constructor(private readonly reason: string) {}

  async start(): Promise<{ containerId: string }> {
    throw new Error(this.reason);
  }

  async stop(): Promise<void> {}
}

export class DockerRuntime implements AgentRuntime {
  constructor(
    private readonly config: AppConfig,
    private readonly docker: string[],
  ) {}

  async start(spec: { id: string; token: string; workspace: string }): Promise<{ containerId: string }> {
    const name = containerName(spec.id);
    await this.quiet(["rm", "-f", name]);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "automaton.managed=1",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "512m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "128",
      "--network",
      this.config.dockerNetwork,
      "--add-host",
      "orchestrator:host-gateway",
      "-e",
      `AGENT_ID=${spec.id}`,
      "-e",
      `AGENT_TOKEN=${spec.token}`,
      "-e",
      `ORCHESTRATOR_URL=${this.config.orchestratorUrl}`,
      "-e",
      "HOME=/workspace",
      "-e",
      `OWNER_DENY_HOSTS=${this.config.denyHosts.join(",")}`,
      "-w",
      "/workspace",
    ];
    if (this.config.dockerVolume) {
      args.push(
        "--mount",
        `type=volume,source=${this.config.dockerVolume},target=/workspace,volume-subpath=agents/${spec.id}/workspace`,
      );
    } else {
      args.push("--mount", `type=bind,source=${spec.workspace},target=/workspace`);
    }
    args.push(this.config.agentImage, "node", "/app/dist/agent/main.js");
    const { stdout } = await exec(this.docker[0], [...this.docker.slice(1), ...args], { timeout: 60_000 });
    return { containerId: stdout.trim() || name };
  }

  async stop(id: string): Promise<void> {
    await this.quiet(["rm", "-f", containerName(id)]);
  }

  private async quiet(args: string[]): Promise<void> {
    try {
      await exec(this.docker[0], [...this.docker.slice(1), ...args], { timeout: 30_000 });
    } catch {
      // The container may already be gone.
    }
  }
}

export async function createRuntime(config: AppConfig, boot: BootFn): Promise<AgentRuntime> {
  if (config.runtime === "process") return new ProcessRuntime(boot);
  const docker = await dockerCommand();
  if (config.runtime === "docker") {
    if (!docker) {
      const reason = "RUNTIME=docker but the docker daemon is not reachable. The orchestrator is up; agent containers are not.";
      console.error(reason);
      return new UnavailableRuntime(reason);
    }
    const image = await hasImage(docker, config.agentImage);
    if (!image) {
      const reason = `RUNTIME=docker but image ${config.agentImage} is not present. Build it with docker compose build.`;
      console.error(reason);
      return new UnavailableRuntime(reason);
    }
    return new DockerRuntime(config, docker);
  }
  if (docker && (await hasImage(docker, config.agentImage))) return new DockerRuntime(config, docker);
  return new ProcessRuntime(boot);
}

async function dockerCommand(): Promise<string[] | null> {
  if (await canRun(["docker", "info"])) return ["docker"];
  if (await canRun(["sudo", "-n", "docker", "info"])) return ["sudo", "-n", "docker"];
  return null;
}

async function hasImage(docker: string[], image: string): Promise<boolean> {
  try {
    await exec(docker[0], [...docker.slice(1), "image", "inspect", image], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function canRun(args: string[]): Promise<boolean> {
  try {
    await exec(args[0], args.slice(1), { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function containerName(id: string): string {
  return `automaton-${id.replace(/[^a-z0-9_-]/gi, "")}`;
}
