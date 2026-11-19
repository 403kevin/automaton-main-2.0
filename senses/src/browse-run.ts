import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SeeError } from "./contract.ts";

export interface BrowseJob {
  task: string;
  maxSteps: number;
  denyHosts: string[];
  llmBaseUrl: string;
  llmToken: string;
  model: string;
}

const BUDGET_MS = 185_000;

export function runBrowseScript(job: BrowseJob): Promise<Record<string, unknown>> {
  const script = fileURLToPath(new URL("../browse.py", import.meta.url));
  const python = process.env.BROWSE_PYTHON || "python3";
  const env = { ...process.env, ANONYMIZED_TELEMETRY: "false", PYTHONUNBUFFERED: "1" };
  delete env.OPENROUTER_API_KEY;
  delete env.BROWSER_USE_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SeeError("Browse exceeded 180 s.", 504));
    }, BUDGET_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(err).length < 8_000) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new SeeError(error.message, 502));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8").trim();
      const stderr = Buffer.concat(err).toString("utf8").trim();
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new SeeError(stderr.slice(0, 300) || `browse.py exited ${code ?? 1}.`, 502));
        return;
      }
      const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      if (record.ok === false) {
        const message = typeof record.error === "string" ? record.error : "browse failed";
        reject(new SeeError(message, 502));
        return;
      }
      if (code !== 0) {
        reject(new SeeError(typeof record.error === "string" ? record.error : `browse.py exited ${code}.`, 502));
        return;
      }
      resolve(record);
    });
    child.stdin.end(
      JSON.stringify({
        task: job.task,
        max_steps: job.maxSteps,
        deny_hosts: job.denyHosts,
        llm_base_url: job.llmBaseUrl,
        llm_token: job.llmToken,
        model: job.model,
        budget_s: 180,
      }),
    );
  });
}
