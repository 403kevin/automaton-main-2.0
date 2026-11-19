import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const LOCK_SCRIPT = `(() => {
  const mark = (name) => { window.__automatonBlock = window.__automatonBlock || name; };
  const lockField = (el) => {
    if (!el || el.nodeType !== 1) return;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const name = ((el.getAttribute("name") || "") + " " + (el.getAttribute("id") || "")).toLowerCase();
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (type === "password" || name.includes("password") || auto.includes("password")) {
      el.disabled = true;
      el.readOnly = true;
      try { el.value = ""; } catch { /* ignore */ }
      mark("password");
    }
    if (type === "file") {
      el.disabled = true;
      el.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); }, true);
      mark("upload");
    }
  };
  document.addEventListener("submit", (event) => {
    event.preventDefault();
    event.stopPropagation();
    mark("form");
  }, true);
  const scan = () => {
    document.querySelectorAll("input, textarea").forEach(lockField);
    const html = document.documentElement ? document.documentElement.innerHTML : "";
    if (/g-recaptcha|h-captcha|cf-turnstile|data-sitekey|funcaptcha/i.test(html)) mark("captcha");
  };
  document.addEventListener("focusin", (event) => lockField(event.target), true);
  const root = document.documentElement || document;
  new MutationObserver(scan).observe(root, { subtree: true, childList: true, attributes: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan);
  else scan();
})();`;

interface Decision {
  block: string | null;
  stop?: boolean;
  reason?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
}

class Cdp {
  next = 0;
  pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  onEvent: (message: CdpMessage) => void = () => undefined;
  ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message || "cdp error"));
        else waiter?.resolve(message.result);
        return;
      }
      if (message.method) this.onEvent(message);
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.next;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }
}

function headerMap(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as { name?: string; value?: string };
      if (row.name) headers[row.name.toLowerCase()] = String(row.value ?? "");
    }
    return headers;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      headers[key.toLowerCase()] = String(item ?? "");
    }
  }
  return headers;
}

async function decide(input: {
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  stage: string;
}): Promise<Decision> {
  const endpoint = process.env.BROWSE_DECIDER ?? "";
  if (!endpoint) return { block: "safety", stop: true, reason: "No decider." };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: input.method,
      url: input.url,
      resource_type: input.resourceType,
      headers: input.headers,
      stage: input.stage,
    }),
  });
  return (await response.json()) as Decision;
}

const blocks = new Set<string>();

function emit(record: Record<string, unknown>): void {
  if (typeof record.block === "string") blocks.add(record.block);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function arm(cdp: Cdp, sessionId: string, targetType: string): Promise<void> {
  if (targetType !== "page" && targetType !== "iframe") return;
  await cdp.send("Page.enable", {}, sessionId).catch(() => undefined);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: LOCK_SCRIPT }, sessionId).catch(() => undefined);
  await cdp.send("Runtime.evaluate", { expression: LOCK_SCRIPT }, sessionId).catch(() => undefined);
  await cdp.send(
    "Target.setAutoAttach",
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId,
  ).catch(() => undefined);
}

const pages: { sessionId: string; url: string }[] = [];
const loadedSessions = new Set<string>();

function chromeBinary(): string {
  const explicit = process.env.BROWSE_CHROMIUM || "";
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/opt/google/chrome/chrome"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  try {
    const managed = chromium.executablePath();
    if (managed && fs.existsSync(managed)) return managed;
  } catch {
    // Playwright has not downloaded a browser. The image still has one on the path above.
  }
  throw new Error("No local Chromium.");
}

async function waitForPort(profile: string): Promise<string> {
  const file = path.join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(file)) {
      const port = fs.readFileSync(file, "utf8").split("\n")[0]?.trim() ?? "";
      if (port) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome did not open a debugging port.");
}

async function exercise(cdp: Cdp, fixture: string): Promise<void> {
  await cdp.send("Target.createTarget", { url: `${fixture}/form` });
  const form = await waitForPage("/form");
  if (form) await waitForLoad(form.sessionId);
  for (let attempt = 0; attempt < 8 && !blocks.has("form"); attempt += 1) {
    if (form) {
      await cdp
        .send(
          "Runtime.evaluate",
          {
            expression: "document.querySelector('#send')?.click(); document.querySelector('form')?.requestSubmit?.() || document.querySelector('form')?.submit();",
            awaitPromise: true,
          },
          form.sessionId,
        )
        .catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await cdp.send("Target.createTarget", { url: `${fixture}/download` });
  for (let attempt = 0; attempt < 15 && !blocks.has("download"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  emit({
    event: "exercise",
    form: blocks.has("form") ? "blocked" : "missed",
    download: blocks.has("download") ? "blocked" : "missed",
    blocks: [...blocks],
  });
}

async function waitForLoad(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (loadedSessions.has(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForPage(fragment: string): Promise<{ sessionId: string; url: string } | undefined> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const found = pages.find((page) => page.url.includes(fragment));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function main(): Promise<void> {
  let chrome: ChildProcess | null = null;
  let profile = "";
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "browse-chrome-"));
    chrome = spawn(
      chromeBinary(),
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const port = await waitForPort(profile);
    const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json())) as {
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) throw new Error("Chrome did not publish a debugger socket.");
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("CDP socket failed.")));
    });
    const cdp = new Cdp(ws);
    cdp.onEvent = (message) => {
      void onCdpEvent(cdp, message).catch((error) => {
        emit({ event: "error", error: error instanceof Error ? error.message : "cdp event failed" });
      });
    };
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
        { urlPattern: "*", requestStage: "Response" },
      ],
    });
    emit({ event: "ready", cdp: `http://127.0.0.1:${port}` });
    if (process.env.BROWSE_EXERCISE === "1" && process.env.FIXTURE_URL) {
      await exercise(cdp, process.env.FIXTURE_URL);
    } else {
      await new Promise<void>((resolve) => {
        process.stdin.on("end", () => resolve());
        process.stdin.resume();
      });
    }
    ws.close();
  } catch (error) {
    emit({ event: "skipped", reason: error instanceof Error ? error.message : "browser failed" });
  } finally {
    chrome?.kill("SIGKILL");
    if (profile) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        // Chrome may still be releasing the profile.
      }
    }
  }
}

async function onCdpEvent(cdp: Cdp, message: CdpMessage): Promise<void> {
  if (message.method === "Target.attachedToTarget") {
    const params = message.params ?? {};
    const info = (params.targetInfo ?? {}) as { type?: string; url?: string };
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : message.sessionId;
    if (sessionId) {
      pages.push({ sessionId, url: info.url ?? "" });
      await arm(cdp, sessionId, info.type ?? "page");
    }
    return;
  }
  if (message.method === "Page.loadEventFired" && message.sessionId) {
    loadedSessions.add(message.sessionId);
    const evaluated = (await cdp
      .send("Runtime.evaluate", { expression: "window.__automatonBlock || ''", returnByValue: true }, message.sessionId)
      .catch(() => undefined)) as { result?: { value?: string } } | undefined;
    const block = evaluated?.result?.value;
    if (block === "captcha" || block === "form" || block === "password" || block === "upload") {
      emit({ event: "stop", block, url: "" });
    }
    return;
  }
  if (message.method !== "Fetch.requestPaused") return;
  const params = message.params ?? {};
  const request = (params.request ?? {}) as { url?: string; method?: string; headers?: unknown };
  const stage = typeof params.responseStatusCode === "number" || params.responseHeaders ? "response" : "request";
  const headers = headerMap(stage === "response" ? params.responseHeaders : request.headers);
  const resourceType = String(params.resourceType ?? "other").toLowerCase();
  if (resourceType === "document" && message.sessionId) {
    const page = pages.find((item) => item.sessionId === message.sessionId);
    if (page && request.url) page.url = String(request.url);
  }
  let decision: Decision = { block: "safety", stop: true, reason: "decider failed" };
  try {
    decision = await decide({
      method: String(request.method ?? "GET"),
      url: String(request.url ?? ""),
      resourceType,
      headers,
      stage,
    });
  } catch {
    decision = { block: "safety", stop: true, reason: "decider failed" };
  }
  if (decision.block) {
    await cdp
      .send(
        "Fetch.failRequest",
        { requestId: params.requestId, errorReason: "BlockedByClient" },
        message.sessionId,
      )
      .catch(() => undefined);
    emit({
      event: decision.stop ? "stop" : "block",
      block: decision.block,
      url: String(request.url ?? ""),
      reason: decision.reason ?? "",
    });
    return;
  }
  if (stage === "request" && resourceType === "document") {
    emit({ event: "url", url: String(request.url ?? "") });
  }
  const command = stage === "response" ? "Fetch.continueResponse" : "Fetch.continueRequest";
  await cdp.send(command, { requestId: params.requestId }, message.sessionId).catch(() => undefined);
}

void main();
