import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlockList, isIP } from "node:net";
import { costUnits } from "./llm.js";

export const INTERNAL_LLM_PATH = "/internal/llm/v1/chat/completions";
const TOKEN_TTL_MS = 240_000;

export interface BrowseLlmPort {
  issue(input: { agentId: string; model: string; now: number }): string;
  /** Revoke the token and return the real OpenRouter cost accumulated for it, in micro-USD. */
  close(token: string): number;
}

interface TokenRow {
  agentId: string;
  model: string;
  expiresAt: number;
  costUnits: number;
  closed: boolean;
}

interface ProxyOptions {
  clock: { now(): number };
  openRouterUrl: string;
  openRouterKey?: string;
  allowCidrs?: string[];
  fetchImpl?: typeof fetch;
  ttlMs?: number;
}

export function normalizeRemoteAddress(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.startsWith("::ffff:")) return trimmed.slice(7);
  return trimmed;
}

/** Empty allow list means loopback development. A non-empty list is the senses subnet. */
export function addressAllowed(remote: string | undefined, cidrs: readonly string[]): boolean {
  if (cidrs.length === 0) return true;
  const ip = normalizeRemoteAddress(remote);
  const family = isIP(ip);
  if (family === 0) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [base, bitsRaw] = cidr.split("/");
    const bits = Number(bitsRaw);
    if (!base || !Number.isInteger(bits)) continue;
    const baseFamily = base.includes(":") ? "ipv6" : "ipv4";
    if (isIP(base) === 0) continue;
    list.addSubnet(base, bits, baseFamily);
  }
  return list.check(ip, family === 6 ? "ipv6" : "ipv4");
}

function dollarsToUnits(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0;
  const units = Math.round(dollars * 1_000_000);
  return Number.isSafeInteger(units) ? units : 0;
}

export class BrowseLlmProxy implements BrowseLlmPort {
  private readonly tokens = new Map<string, TokenRow>();
  readonly allowCidrs: string[];

  constructor(private readonly options: ProxyOptions) {
    this.allowCidrs = options.allowCidrs ?? [];
  }

  issue(input: { agentId: string; model: string; now: number }): string {
    const token = `brw_${randomBytes(24).toString("hex")}`;
    this.tokens.set(token, {
      agentId: input.agentId,
      model: input.model,
      expiresAt: input.now + (this.options.ttlMs ?? TOKEN_TTL_MS),
      costUnits: 0,
      closed: false,
    });
    return token;
  }

  close(token: string): number {
    const row = this.tokens.get(token);
    if (!row) return 0;
    row.closed = true;
    return row.costUnits;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0] || "/";
    if (path.startsWith("/a/") || path === "/a") {
      send(res, 404, { error: "Not found." });
      return;
    }
    if (!addressAllowed(req.socket.remoteAddress, this.allowCidrs)) {
      send(res, 403, { error: "llm proxy is only reachable on the senses network" });
      return;
    }
    if (req.method !== "POST" || (path !== INTERNAL_LLM_PATH && path !== `${INTERNAL_LLM_PATH}/`)) {
      send(res, 404, { error: "Not found." });
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      send(res, 401, { error: "missing token" });
      return;
    }
    const row = this.lookup(token);
    if (!row) {
      send(res, 401, { error: "invalid token" });
      return;
    }
    if (row.closed) {
      send(res, 401, { error: "reused token" });
      return;
    }
    if (this.options.clock.now() > row.expiresAt) {
      send(res, 401, { error: "expired token" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : "Bad request." });
      return;
    }
    body.model = row.model;
    body.stream = false;
    const completion = await this.forward(body, row);
    if (!completion.ok) {
      send(res, completion.status, { error: completion.error });
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end(completion.raw);
  }

  private lookup(token: string): TokenRow | undefined {
    const row = this.tokens.get(token);
    if (!row) return undefined;
    const stored = Buffer.from(token);
    const given = Buffer.from(token);
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) return undefined;
    return row;
  }

  private async forward(
    body: Record<string, unknown>,
    row: TokenRow,
  ): Promise<{ ok: true; raw: string } | { ok: false; status: number; error: string }> {
    if (!this.options.openRouterKey) {
      const mock = {
        id: "browse-mock",
        choices: [{ index: 0, message: { role: "assistant", content: "I am an AI agent reading the page." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
      };
      return { ok: true, raw: JSON.stringify(mock) };
    }
    const fetcher = this.options.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetcher(this.options.openRouterUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:4747",
          "X-Title": "Automaton",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "OpenRouter is unreachable.";
      return { ok: false, status: 502, error: message };
    }
    const raw = await response.text();
    if (!response.ok) return { ok: false, status: 502, error: `OpenRouter HTTP ${response.status}` };
    try {
      const parsed = JSON.parse(raw) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      row.costUnits += usageCost(parsed.usage, row.model);
    } catch {
      return { ok: false, status: 502, error: "OpenRouter returned invalid JSON." };
    }
    return { ok: true, raw };
  }
}

function usageCost(
  usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | undefined,
  model: string,
): number {
  if (!usage) return 0;
  if (typeof usage.cost === "number") return dollarsToUnits(usage.cost);
  return costUnits(
    { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 },
    model,
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required.");
  return parsed as Record<string, unknown>;
}

export function startInternalLlmServer(
  proxy: BrowseLlmProxy,
  port: number,
  host: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void proxy.handle(req, res).catch((error) => {
      const message = error instanceof Error ? error.message : "Proxy failed.";
      send(res, 500, { error: message });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : port;
      const hostName = host === "0.0.0.0" ? "127.0.0.1" : host;
      resolve({
        url: `http://${hostName}:${bound}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
