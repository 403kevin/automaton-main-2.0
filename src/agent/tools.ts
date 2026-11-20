import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { reviewCommand, reviewText, reviewUrl } from "../constitution.js";
import { guardSenseText } from "../tripwires.js";
import type { ToolCall } from "../types.js";

export const FEED_SOURCE_NAMES = [
  "hn",
  "bluesky",
  "wikipedia",
  "wikimedia-pageviews",
  "arxiv",
  "archive",
  "rss",
  "x402-bazaar",
  "reddit",
] as const;

export const TOOL_DEFINITIONS = [
  { name: "shell", description: "Run a shell command in your workspace. The container is the sandbox. Host secrets are not available.", parameters: { command: { type: "string" } }, required: ["command"] },
  { name: "fetch_url", description: "HTTP GET a public http(s) URL. Private networks and the owner's accounts are blocked.", parameters: { url: { type: "string" } }, required: ["url"] },
  { name: "web_search", description: "Search the web through the configured provider.", parameters: { query: { type: "string" } }, required: ["query"] },
  { name: "see_page", description: "Read a public http(s) page through the shared browser: title, main text as markdown, and links. screenshot saves a PNG under evidence/. Private addresses are refused. Debited from your ledger.", parameters: { url: { type: "string" }, screenshot: { type: "boolean" } }, required: ["url"] },
  { name: "crawl_site", description: "Read a small part of one public site: robots.txt, sitemap, then pages as markdown. Same host only unless same_domain is false. Private addresses are refused. Debited per page from your ledger.", parameters: { url: { type: "string" }, max_pages: { type: "number" }, same_domain: { type: "boolean" } }, required: ["url"] },
  { name: "read_feed", description: "Read a free public feed. source is hn, bluesky, wikipedia, wikimedia-pageviews, arxiv, archive, rss, x402-bazaar, or reddit. rss is an http(s) URL. No API key. Debited from your ledger. A reddit block still costs the call.", parameters: { source: { type: "string", enum: [...FEED_SOURCE_NAMES] }, query: { type: "string" }, options: { type: "object" } }, required: ["source", "query"] },
  { name: "browse", description: "Read public pages with the shared local browser to answer a task. Read-only: no form submits, logins, uploads, or CAPTCHA solving. max_steps is at most 15. The owner must turn it on. Debited from your ledger.", parameters: { task: { type: "string" }, max_steps: { type: "number" } }, required: ["task"] },
  { name: "read_file", description: "Read a file inside the workspace, or a read-only reference file under /ref.", parameters: { path: { type: "string" } }, required: ["path"] },
  { name: "write_file", description: "Write a file inside the workspace.", parameters: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  { name: "offer_service", description: "Publish a paid HTTP response. Buyers pay USDC per request. The gateway tells them you are an AI.", parameters: { priceUsd: { type: "string" }, description: { type: "string" }, body: { type: "string" } }, required: ["priceUsd", "description", "body"] },
  { name: "publish_page", description: "Publish one static markdown page at /a/<your id>/<slug>. The server renders it, escapes raw HTML and scripts, and adds a banner that an autonomous AI wrote the page. Debited from your ledger. A refused page costs nothing.", parameters: { slug: { type: "string" }, markdown: { type: "string" } }, required: ["slug", "markdown"] },
  { name: "serve_endpoint", description: "Register a paid endpoint at /a/<your id>/<name>. handler_dir is one workspace directory containing handler.js. Node reads request JSON on stdin and writes the response on stdout. The directory is snapshotted. Buyers pay price_usd only when the handler succeeds. Registration is debited from your ledger.", parameters: { name: { type: "string" }, price_usd: { type: "string" }, handler_dir: { type: "string" } }, required: ["name", "price_usd", "handler_dir"] },
  { name: "pay_request", description: "Pay another local agent's x402 offer from your wallet, up to maxUsd.", parameters: { url: { type: "string" }, maxUsd: { type: "string" } }, required: ["url", "maxUsd"] },
  { name: "council", description: "Pay the council fee to ask the configured models and receive one synthesis.", parameters: { question: { type: "string" } }, required: ["question"] },
  { name: "spawn_child", description: "If you are in earned profit, pay the endowment from your ledger and spawn a child.", parameters: { name: { type: "string" } }, required: ["name"] },
  { name: "remember", description: "Append a strategy note. This does not credit income.", parameters: { note: { type: "string" } }, required: ["note"] },
  { name: "balance", description: "Read your ledger balance, tier, and rent. This does not change the ledger.", parameters: {}, required: [] },
];

export function toolsForModel(): unknown[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters,
        required: tool.required,
      },
    },
  }));
}

export async function executeLocalTool(input: {
  workspace: string;
  call: ToolCall;
  denyHosts: string[];
}): Promise<string> {
  const args = input.call.arguments;
  if (input.call.name === "shell") {
    const command = String(args.command ?? "");
    const review = reviewCommand(command);
    if (!review.allowed) return review.reason;
    return runShell(input.workspace, command);
  }
  if (input.call.name === "fetch_url") {
    const url = String(args.url ?? "");
    const review = await reviewUrl(url, input.denyHosts, async (host) => {
      const dns = await import("node:dns/promises");
      const looked = await dns.lookup(host, { all: true });
      return looked.map((entry) => entry.address);
    });
    if (!review.allowed) return review.reason;
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    return `HTTP ${response.status}\n${text.slice(0, 12_000)}`;
  }
  if (input.call.name === "read_file" || input.call.name === "write_file") {
    const requested = String(args.path ?? "");
    const kind = classifyAgentPath(requested);
    if (kind === "deny") return "Paths must stay inside the workspace.";
    if (kind === "ref") {
      if (input.call.name === "write_file") return "Reference files are read-only.";
      return readRef(requested);
    }
    const target = resolveWorkspace(input.workspace, requested);
    if (!target) return "Paths must stay inside the workspace.";
    if (input.call.name === "read_file") return readWorkspaceFile(input.workspace, target);
    const content = String(args.content ?? "");
    const review = reviewText(content);
    if (!review.allowed) return review.reason;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return `Wrote ${path.relative(input.workspace, target)} (${content.length} bytes).`;
  }
  return "This tool is handled by the orchestrator.";
}

let refRoot = "/ref";

/** Production reads `/ref`. Tests point this at a temporary directory. */
export function setRefRoot(next: string): void {
  refRoot = path.resolve(next);
}

export function getRefRoot(): string {
  return refRoot;
}

export function classifyAgentPath(requested: string): "workspace" | "ref" | "deny" {
  if (requested.includes("\0")) return "deny";
  const root = path.resolve(refRoot);
  if (requested === root || requested.startsWith(`${root}${path.sep}`)) {
    const target = path.resolve(requested);
    if (target === root || target.startsWith(`${root}${path.sep}`)) return "ref";
    return "deny";
  }
  if (requested.includes("..") || path.isAbsolute(requested)) return "deny";
  return "workspace";
}

function readRef(requested: string): string {
  const root = path.resolve(refRoot);
  const target = path.resolve(requested);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return "Paths must stay inside the workspace.";
  let realRoot = root;
  let real = target;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(target);
  } catch {
    return "File not found.";
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return "Paths must stay inside the workspace.";
  if (!fs.statSync(real).isFile()) return "File not found.";
  return fs.readFileSync(real, "utf8").slice(0, 12_000);
}

/**
 * Read a workspace file. The real path (symlinks followed) must stay inside the real workspace, so a link cannot
 * reach a file outside it. Anything under evidence/ holds text that came from the outside world (saved pages,
 * crawls, feeds, browse transcripts), so it goes through the same tripwires and fence as a live sense result.
 */
function readWorkspaceFile(workspace: string, target: string): string {
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(workspace);
    real = fs.realpathSync(target);
  } catch {
    return "File not found.";
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return "Paths must stay inside the workspace.";
  if (!fs.statSync(real).isFile()) return "File not found.";
  const text = fs.readFileSync(real, "utf8").slice(0, 12_000);
  const inEvidence = path.relative(realRoot, real).split(path.sep)[0] === "evidence";
  return inEvidence ? guardSenseText("read_file", text).output : text;
}

function resolveWorkspace(workspace: string, requested: string): string | null {
  if (!requested || requested.includes("\0") || path.isAbsolute(requested)) return null;
  const root = path.resolve(workspace);
  const target = path.resolve(root, requested);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return target;
}

function runShell(workspace: string, command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: workspace, LANG: "C.UTF-8" },
      timeout: 20_000,
    });
    let out = "";
    const append = (chunk: Buffer) => {
      if (out.length < 16_000) out += chunk.toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve(error.message));
    child.on("close", (code) => resolve(`exit ${code ?? 1}\n${out.slice(0, 16_000)}`));
  });
}
