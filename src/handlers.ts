import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPublicSlug } from "./pages.js";

/**
 * Paid handler contract. One runtime: Node.
 * The snapshot is mounted at `/handler`. The process is `node handler.js`.
 * Stdin is one JSON object: `{ method, path, query, body }`.
 * Stdout is the response body, JSON or text, capped at 256 KB.
 * Exit 0 with non-empty stdout is the only result that settles a payment.
 * The container has no network, no host environment, and a read-only root except tmpfs `/tmp`.
 */
export const HANDLER_ENTRY = "handler.js";
export const DEFAULT_HANDLER_TIMEOUT_MS = 10_000;
export const DEFAULT_HANDLER_QUEUE_TIMEOUT_MS = 10_000;
export const MAX_HANDLER_STDOUT = 256 * 1024;
export const MAX_HANDLER_CONCURRENCY = 2;
export const MAX_ENDPOINTS_PER_AGENT = 5;
export const HANDLER_USER = "65534:65534";
/** Used only when the agent image has no Node. Official node slim, version-pinned. */
export const PINNED_NODE_SLIM = "node:22.21.0-bookworm-slim";

const MAX_SNAPSHOT_FILES = 32;
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const MAX_SNAPSHOT_DEPTH = 4;

export function selectHandlerImage(agentImage: string, agentImageHasNode: boolean): string {
  if (agentImageHasNode && agentImage.trim()) return agentImage;
  return PINNED_NODE_SLIM;
}

export function handlerSnapshotRoot(dataDir: string): string {
  return path.resolve(dataDir, "handler-snapshots");
}

export interface HandlerRunResult {
  ok: boolean;
  code: "ok" | "timeout" | "empty" | "error" | "limit" | "busy" | "start";
  output: string;
  exitCode: number | null;
  durationMs: number;
  bytesOut: number;
  publicReason: string;
  killed: boolean;
}

export function handlerHttpStatus(code: HandlerRunResult["code"]): number {
  return code === "busy" ? 503 : 502;
}

export interface SnapshotResult {
  ok: true;
  hash: string;
  dir: string;
}

interface ListedFile {
  rel: string;
  bytes: Buffer;
}

export function snapshotHandlerDir(input: {
  workspace: string;
  handlerDir: string;
  storeRoot: string;
}): SnapshotResult | { ok: false; error: string } {
  if (!isPublicSlug(input.handlerDir)) {
    return { ok: false, error: "handler_dir must be one directory name of 1-40 lowercase letters, numbers, or dashes." };
  }
  const workspace = path.resolve(input.workspace);
  const store = path.resolve(input.storeRoot);
  let realWorkspace = workspace;
  try {
    realWorkspace = fs.realpathSync(workspace);
  } catch {
    return { ok: false, error: "Workspace is not available." };
  }
  if (store === realWorkspace || store.startsWith(`${realWorkspace}${path.sep}`) || realWorkspace.startsWith(`${store}${path.sep}`)) {
    return { ok: false, error: "Snapshot store must be outside the workspace." };
  }
  const requested = path.resolve(workspace, input.handlerDir);
  if (requested !== path.join(workspace, input.handlerDir)) {
    return { ok: false, error: "handler_dir must stay inside the workspace." };
  }
  let realSource: string;
  try {
    const stat = fs.lstatSync(requested);
    if (stat.isSymbolicLink()) return { ok: false, error: "handler_dir must not be a symlink." };
    realSource = fs.realpathSync(requested);
  } catch {
    return { ok: false, error: "handler_dir was not found in the workspace." };
  }
  if (realSource !== realWorkspace && !realSource.startsWith(`${realWorkspace}${path.sep}`)) {
    return { ok: false, error: "handler_dir must stay inside the workspace." };
  }
  if (!fs.statSync(realSource).isDirectory()) return { ok: false, error: "handler_dir must be a directory." };
  const listed = listHandlerFiles(realSource);
  if (!listed.ok) return listed;
  const hash = hashFiles(listed.files);
  const dest = path.join(store, hash);
  if (!/^[a-f0-9]{64}$/.test(hash) || path.dirname(dest) !== store) {
    return { ok: false, error: "Snapshot path was refused." };
  }
  fs.mkdirSync(store, { recursive: true });
  if (!fs.existsSync(dest)) writeSnapshot(store, dest, hash, listed.files);
  return { ok: true, hash, dir: dest };
}

export function buildHandlerRunArgs(input: { name: string; image: string; mount: string; user: string }): string[] {
  return [
    "run",
    "--name",
    input.name,
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "128m",
    "--cpus",
    "0.25",
    "--user",
    input.user,
    "--mount",
    input.mount,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
    "-w",
    "/handler",
    input.image,
    "node",
    HANDLER_ENTRY,
  ];
}

export function handlerMount(input: { dockerVolume: string; snapshotHash: string; snapshotDir: string }): string {
  if (input.dockerVolume) {
    return `type=volume,source=${input.dockerVolume},target=/handler,volume-subpath=handler-snapshots/${input.snapshotHash},readonly`;
  }
  return `type=bind,source=${input.snapshotDir},target=/handler,readonly`;
}

export interface HandlerSandboxOptions {
  docker: string[];
  image: string;
  snapshotRoot: string;
  dockerVolume?: string;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  concurrency?: number;
  user?: string;
  maxStdout?: number;
}

interface Waiter {
  resolve: (granted: boolean) => void;
  timer: NodeJS.Timeout;
}

export class HandlerSandbox {
  readonly timeoutMs: number;
  readonly queueTimeoutMs: number;
  readonly concurrency: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly activeNames = new Set<string>();
  private readonly children = new Map<string, ChildProcess>();
  private closed = false;
  private readonly maxStdout: number;
  private readonly user: string;

  constructor(private readonly options: HandlerSandboxOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_HANDLER_QUEUE_TIMEOUT_MS;
    this.concurrency = options.concurrency ?? MAX_HANDLER_CONCURRENCY;
    this.maxStdout = options.maxStdout ?? MAX_HANDLER_STDOUT;
    this.user = options.user ?? HANDLER_USER;
  }

  async run(input: { snapshotHash: string; stdin: string }): Promise<HandlerRunResult> {
    if (this.closed) return failed("start", "Handler runner is shut down.", 0, 0);
    if (!/^[a-f0-9]{64}$/.test(input.snapshotHash)) return failed("start", "Handler snapshot was refused.", 0, 0);
    const granted = await this.acquire();
    if (!granted) return failed("busy", "Handler capacity is full. Try again.", 0, 0);
    try {
      return await this.spawnOnce(input);
    } finally {
      this.release();
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    for (const child of this.children.values()) child.kill("SIGKILL");
    const names = [...this.activeNames];
    await Promise.all(names.map((name) => this.killContainer(name)));
  }

  private async spawnOnce(input: { snapshotHash: string; stdin: string }): Promise<HandlerRunResult> {
    const snapshotDir = path.join(this.options.snapshotRoot, input.snapshotHash);
    if (!fs.existsSync(snapshotDir)) return failed("start", "Handler snapshot is missing.", 0, 0);
    const name = `automaton-h-${randomBytes(8).toString("hex")}`;
    const args = buildHandlerRunArgs({
      name,
      image: this.options.image,
      user: this.user,
      mount: handlerMount({
        dockerVolume: this.options.dockerVolume ?? "",
        snapshotHash: input.snapshotHash,
        snapshotDir,
      }),
    });
    const started = Date.now();
    const child = spawn(this.options.docker[0] ?? "docker", [...this.options.docker.slice(1), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    this.activeNames.add(name);
    this.children.set(name, child);
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill("SIGKILL");
      this.activeNames.delete(name);
      this.children.delete(name);
      return failed("start", "Handler could not be started.", Date.now() - started, 0);
    }
    let settled = false;
    let killed = false;
    let overLimit = false;
    let bytesOut = 0;
    const chunks: Buffer[] = [];

    const outcome = new Promise<HandlerRunResult>((resolve) => {
      const finish = (result: HandlerRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(fallback);
        this.activeNames.delete(name);
        this.children.delete(name);
        resolve(result);
      };
      let fallback: NodeJS.Timeout = setTimeout(() => undefined, 1);
      const timer = setTimeout(() => {
        killed = true;
        void this.killContainer(name).finally(() => {
          child.kill("SIGKILL");
          fallback = setTimeout(() => {
            finish({
              ok: false,
              code: "timeout",
              output: "",
              exitCode: null,
              durationMs: Date.now() - started,
              bytesOut,
              publicReason: "Handler timed out.",
              killed: true,
            });
          }, 500);
        });
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesOut += buffer.length;
        if (bytesOut > this.maxStdout) {
          overLimit = true;
          killed = true;
          chunks.length = 0;
          void this.killContainer(name).finally(() => child.kill("SIGKILL"));
          return;
        }
        chunks.push(buffer);
      });
      child.stderr.on("data", () => undefined);
      child.on("error", () => {
        finish(failed("start", "Handler could not be started.", Date.now() - started, bytesOut));
      });
      child.on("close", (code) => {
        const durationMs = Date.now() - started;
        if (overLimit) {
          finish({
            ok: false,
            code: "limit",
            output: "",
            exitCode: code,
            durationMs,
            bytesOut,
            publicReason: "Handler output was too large.",
            killed: true,
          });
          return;
        }
        if (killed || code === null) {
          finish({
            ok: false,
            code: "timeout",
            output: "",
            exitCode: code,
            durationMs,
            bytesOut,
            publicReason: "Handler timed out.",
            killed: true,
          });
          return;
        }
        if (code !== 0) {
          finish({
            ok: false,
            code: "error",
            output: "",
            exitCode: code,
            durationMs,
            bytesOut,
            publicReason: "Handler failed.",
            killed: false,
          });
          return;
        }
        const output = Buffer.concat(chunks).toString("utf8");
        if (output.trim() === "") {
          finish({
            ok: false,
            code: "empty",
            output: "",
            exitCode: code,
            durationMs,
            bytesOut,
            publicReason: "Handler returned no output.",
            killed: false,
          });
          return;
        }
        finish({
          ok: true,
          code: "ok",
          output,
          exitCode: code,
          durationMs,
          bytesOut,
          publicReason: "",
          killed: false,
        });
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin);
    return outcome;
  }

  private async killContainer(name: string): Promise<void> {
    await this.execQuiet(["kill", name]);
    await this.execQuiet(["rm", "-f", name]);
  }

  private execQuiet(args: string[]): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(this.options.docker[0] ?? "docker", [...this.options.docker.slice(1), ...args], {
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private acquire(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (granted) => resolve(granted),
        timer: setTimeout(() => undefined, this.queueTimeoutMs),
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve(true);
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function failed(code: HandlerRunResult["code"], publicReason: string, durationMs: number, bytesOut: number): HandlerRunResult {
  return { ok: false, code, output: "", exitCode: null, durationMs, bytesOut, publicReason, killed: code === "timeout" };
}

function listHandlerFiles(root: string): { ok: true; files: ListedFile[] } | { ok: false; error: string } {
  const files: ListedFile[] = [];
  let total = 0;
  const walk = (dir: string, depth: number): string | null => {
    if (depth > MAX_SNAPSHOT_DEPTH) return "Handler directory is too deep.";
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return "Handler directory could not be read.";
    }
    for (const entry of entries) {
      if (entry.name.includes("/") || entry.name.includes("\\") || entry.name.includes("\0") || entry.name === "." || entry.name === "..") {
        return "Handler path is refused.";
      }
      const absolute = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        return "Handler directory could not be read.";
      }
      if (stat.isSymbolicLink()) return "Handler snapshots refuse symlinks.";
      const rel = path.relative(root, absolute).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "Handler path is refused.";
      if (stat.isDirectory()) {
        const nested = walk(absolute, depth + 1);
        if (nested) return nested;
        continue;
      }
      if (!stat.isFile()) return "Handler snapshots only copy regular files.";
      if (files.length >= MAX_SNAPSHOT_FILES) return "Handler directory has too many files.";
      const bytes = fs.readFileSync(absolute);
      total += bytes.length;
      if (total > MAX_SNAPSHOT_BYTES) return "Handler directory is too large.";
      files.push({ rel, bytes });
    }
    return null;
  };
  const error = walk(root, 1);
  if (error) return { ok: false, error };
  if (!files.some((file) => file.rel === HANDLER_ENTRY)) return { ok: false, error: "handler.js is required in handler_dir." };
  return { ok: true, files };
}

function hashFiles(files: ListedFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0))) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeSnapshot(store: string, dest: string, hash: string, files: ListedFile[]): void {
  const tmp = path.join(store, `.tmp-${hash}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const file of files) {
      const target = path.join(tmp, ...file.rel.split("/"));
      const parent = path.dirname(target);
      if (parent !== tmp && !parent.startsWith(`${tmp}${path.sep}`)) throw new Error("Snapshot path was refused.");
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
    try {
      if (!fs.existsSync(dest)) fs.renameSync(tmp, dest);
    } catch (error) {
      if (!fs.existsSync(dest)) throw error;
    }
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (fs.existsSync(dest)) chmodTree(dest);
}

/** Owner can still delete the store. The container user is not the owner, and the mount is read-only. */
function chmodTree(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      chmodTree(absolute);
      fs.chmodSync(absolute, 0o755);
    } else {
      fs.chmodSync(absolute, 0o644);
    }
  }
  fs.chmodSync(root, 0o755);
}
