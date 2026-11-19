import http from "node:http";
import { pathToFileURL } from "node:url";
import { type BrowseRequest, type PageView, SeeError } from "./contract.ts";
import { SerialQueue } from "./queue.ts";
import {
  defaultFetchHop,
  defaultResolve,
  MAX_BODY_BYTES,
  reviewSeeUrl,
  type FetchHop,
  type ResolveHost,
} from "./safety.ts";

const REQUEST_LIMIT = 64 * 1024;

export interface SensesServerOptions {
  browse?: (input: BrowseRequest) => Promise<PageView>;
  resolveHost?: ResolveHost;
  fetchHop?: FetchHop;
  executablePath?: string;
  launchArgs?: string[];
}

interface JobResult {
  status: number;
  body: unknown;
}

export function createSensesServer(options: SensesServerOptions = {}): http.Server {
  const queue = new SerialQueue();
  const resolveHost = options.resolveHost ?? defaultResolve;
  const fetchHop = options.fetchHop ?? defaultFetchHop;
  const see =
    options.browse ??
    (async (input: BrowseRequest) => {
      const mod = await import("./browse.ts");
      return mod.browse({
        ...input,
        executablePath: options.executablePath,
        launchArgs: options.launchArgs,
      });
    });

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST" || (req.url !== "/see" && req.url !== "/see/")) {
        send(res, 404, { error: "Not found." });
        return;
      }
      const result = await queue.run(() => handleSee(req, see, resolveHost, fetchHop));
      send(res, result.status, result.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "see failed";
      const status = error instanceof SeeError ? error.status : 500;
      if (!res.headersSent) send(res, status, { error: message });
    }
  });
}

async function handleSee(
  req: http.IncomingMessage,
  see: (input: BrowseRequest) => Promise<PageView>,
  resolveHost: ResolveHost,
  fetchHop: FetchHop,
): Promise<JobResult> {
  let raw: string;
  try {
    raw = await readBody(req, REQUEST_LIMIT);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the request.";
    return { status: 400, body: { error: message } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "Request body is not JSON." } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "Request body must be an object." } };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.url !== "string" || !record.url.trim()) {
    return { status: 400, body: { error: "url is required." } };
  }
  const screenshot = record.screenshot === true;
  const denyHosts = Array.isArray(record.denyHosts)
    ? record.denyHosts.filter((item): item is string => typeof item === "string")
    : [];
  const reviewed = await reviewSeeUrl(record.url, denyHosts, resolveHost, fetchHop);
  if (!reviewed.allowed) return { status: 400, body: { error: reviewed.reason } };
  try {
    const page = await see({ url: record.url, screenshot, denyHosts, resolveHost });
    const body: PageView = {
      title: page.title,
      markdown: page.markdown,
      links: page.links,
    };
    if (screenshot && page.png) body.png = page.png;
    return { status: 200, body };
  } catch (error) {
    if (error instanceof SeeError) return { status: error.status, body: { error: error.message } };
    const message = error instanceof Error ? error.message : "see failed";
    return { status: 502, body: { error: message } };
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new SeeError("Request body is too large.", 400));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  let payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES) {
    payload = JSON.stringify({ error: "Response body exceeds 2 MB." });
    status = 413;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  const port = Number(process.env.PORT ?? "7070");
  const server = createSensesServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({ msg: "senses listening", port }));
  });
}
