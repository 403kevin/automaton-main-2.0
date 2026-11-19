import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DockerRuntime } from "../src/runtime.js";

describe("docker agent runtime", () => {
  it("does not give an agent container a route to the host", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-docker-"));
    const log = path.join(dir, "args.log");
    const docker = path.join(dir, "docker.cjs");
    fs.writeFileSync(
      docker,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("container-id\\n");
`,
    );
    fs.chmodSync(docker, 0o755);
    const probe = spawnSync(docker, ["version"], { encoding: "utf8" });
    expect(probe.status).toBe(0);

    const config = loadConfig({
      DATA_DIR: dir,
      WALLET_MASTER_KEY: "test-master-key-1234",
      ADMIN_TOKEN: "test-admin",
      RUNTIME: "docker",
    });
    const runtime = new DockerRuntime(config, [docker]);
    await runtime.start({ id: "agent_1", token: "agent-token", workspace: path.join(dir, "ws") });

    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const run = calls.find((args) => args[0] === "run");
    expect(run).toBeTruthy();
    const flat = run!.join("\n");
    expect(flat).not.toContain("--add-host");
    expect(flat).not.toContain("host-gateway");
    expect(run).toContain("--network");
    expect(run).toContain(config.dockerNetwork);
    expect(run).toContain(`ORCHESTRATOR_URL=${config.orchestratorUrl}`);
    expect(config.orchestratorUrl).toBe("http://orchestrator:4747");
  });
});
