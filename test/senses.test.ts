import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deniedHostMatch } from "../src/constitution.js";
import { createSensesServer, type SensesServerOptions } from "../senses/src/server.ts";
import {
  MAX_BODY_BYTES,
  PAGE_TIMEOUT_MS,
  constitutionDenySource,
  localDeniedHostMatch,
  localIsBlockedAddress,
  reviewHop,
  reviewSeeUrl,
  type FetchHop,
  type ResolveHost,
} from "../senses/src/safety.ts";

const PUBLIC = "93.184.216.34";

function resolveHost(host: string): Promise<string[]> {
  if (host === "fixture.example") return Promise.resolve([PUBLIC]);
  return Promise.resolve([host]);
}

const allowHop: FetchHop = async () => ({ status: 200, location: null });

async function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function startSenses(options: SensesServerOptions = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createSensesServer({ resolveHost, fetchHop: allowHop, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("senses did not bind");
  return {
    port: address.port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function postSee(port: number, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/see`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function serviceBlock(file: string, name: string): string {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`missing service ${name} in ${file}`);
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:/.test(lines[index] ?? "")) break;
    body.push(lines[index] ?? "");
  }
  return body.join("\n");
}

describe("senses url safety", () => {
  it("blocks the private, link-local, loopback, and CGNAT ranges", () => {
    expect(PAGE_TIMEOUT_MS).toBe(20_000);
    expect(MAX_BODY_BYTES).toBe(2_000_000);
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.20",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      expect(localIsBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1"]) {
      expect(localIsBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("reuses the constitution host check when that module can be imported", async () => {
    expect(await constitutionDenySource()).toBe("constitution");
    expect(localDeniedHostMatch("news.blocked.example", ["blocked.example"])).toBe(
      deniedHostMatch("news.blocked.example", ["blocked.example"]),
    );
    const verdict = await reviewHop("https://news.blocked.example/a", ["blocked.example"], resolveHost);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("blocked.example");
    const decimal = await reviewHop("http://2130706433/", [], resolveHost);
    const hex = await reviewHop("http://0x7f000001/", [], resolveHost);
    const dotted = await reviewHop("http://0177.0.0.1/", [], resolveHost);
    expect(decimal.allowed).toBe(false);
    expect(hex.allowed).toBe(false);
    expect(dotted.allowed).toBe(false);
    expect((await reviewHop("http://8.8.8.8/", [], resolveHost)).allowed).toBe(true);
  });

  it("refuses metadata, private addresses, and a fixture that redirects to loopback", async () => {
    const hits: string[] = [];
    const fixture = await listen((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/jump") {
        res.writeHead(302, { location: "http://127.0.0.1/secret" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret");
    });
    let browsed = 0;
    const fetchHop: FetchHop = async (url) => {
      const target = new URL(url);
      if (target.hostname === "fixture.example") target.hostname = "127.0.0.1";
      const response = await fetch(target, { redirect: "manual" });
      const location = response.headers.get("location");
      await response.body?.cancel();
      return { status: response.status, location };
    };
    const senses = await startSenses({
      fetchHop,
      browse: async () => {
        browsed += 1;
        return { title: "", markdown: "", links: [] };
      },
    });
    try {
      const metadata = await postSee(senses.port, { url: "http://169.254.169.254/latest/meta-data" });
      const ten = await postSee(senses.port, { url: "http://10.0.0.1/" });
      const redirect = await postSee(senses.port, { url: `http://fixture.example:${fixture.port}/jump` });
      const denied = await postSee(senses.port, { url: "https://cdn.blocked.example/a", denyHosts: ["blocked.example"] });
      expect(metadata.status).toBe(400);
      expect(String(metadata.body.error)).toMatch(/private|link-local/i);
      expect(ten.status).toBe(400);
      expect(String(ten.body.error)).toMatch(/private|link-local/i);
      expect(redirect.status).toBe(400);
      expect(String(redirect.body.error)).toMatch(/private|link-local/i);
      expect(denied.status).toBe(400);
      expect(String(denied.body.error)).toContain("blocked.example");
      expect(browsed).toBe(0);
      expect(hits).toEqual(["/jump"]);
    } finally {
      await senses.close();
      await fixture.close();
    }
  });

  it("serves five parallel requests one at a time", async () => {
    const spans: { start: number; end: number }[] = [];
    let active = 0;
    let max = 0;
    const senses = await startSenses({
      browse: async () => {
        active += 1;
        max = Math.max(max, active);
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 40));
        const end = Date.now();
        active -= 1;
        spans.push({ start, end });
        return { title: "Queued", markdown: "one", links: [] };
      },
    });
    try {
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((item) => postSee(senses.port, { url: `http://${PUBLIC}/${item}` })),
      );
      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(max).toBe(1);
      expect(spans).toHaveLength(5);
      for (let index = 1; index < spans.length; index += 1) {
        expect(spans[index]?.start).toBeGreaterThanOrEqual(spans[index - 1]?.end ?? 0);
      }
    } finally {
      await senses.close();
    }
  });

  it("refuses a response larger than 2 MB", async () => {
    const senses = await startSenses({
      browse: async () => ({ title: "Big", markdown: "x".repeat(MAX_BODY_BYTES + 1), links: [] }),
    });
    try {
      const result = await postSee(senses.port, { url: `http://${PUBLIC}/big` });
      expect(result.status).toBe(413);
      expect(String(result.body.error)).toMatch(/2 MB/);
    } finally {
      await senses.close();
    }
  });
});

describe("senses compose", () => {
  it("keeps the browser off the agent network and limits the container", () => {
    const compose = fs.readFileSync("docker-compose.yml", "utf8");
    const senses = serviceBlock("docker-compose.yml", "senses");
    const orchestrator = serviceBlock("docker-compose.yml", "orchestrator");
    const safe = serviceBlock("docker-compose.safe.yml", "senses");
    expect(compose).toContain("name: automaton_default");
    expect(compose).toContain("name: automaton_senses");
    expect(senses).not.toMatch(/^\s*ports:/m);
    expect(senses).toContain("- senses");
    expect(senses).not.toContain("- default");
    expect(senses).toContain('cpus: "1.0"');
    expect(senses).toContain("memory: 1g");
    expect(senses).toContain("read_only: true");
    expect(senses).toContain("/tmp:rw,nosuid,size=512m");
    expect(senses).toContain("json-file");
    expect(senses).toContain('max-size: "10m"');
    expect(senses).toContain('max-file: "3"');
    expect(orchestrator).toContain("SENSES_URL: http://senses:7070");
    expect(orchestrator).toContain("- default");
    expect(orchestrator).toContain("- senses");
    expect(safe).toContain('cpus: "1.0"');
    expect(safe).toContain("memory: 1g");
    expect(safe).toContain("json-file");
    expect(safe).toContain('max-size: "10m"');
  });
});

interface Launch {
  executablePath?: string;
  args: string[];
}

async function detectBrowser(): Promise<Launch | null> {
  let playwright: { chromium: { launch: (options: Record<string, unknown>) => Promise<{ close: () => Promise<void> }> } };
  try {
    const require = createRequire(path.resolve("senses/package.json"));
    playwright = require("playwright");
  } catch {
    return null;
  }
  const candidates: Launch[] = [
    { args: ["--disable-dev-shm-usage"] },
    { executablePath: "/usr/local/bin/google-chrome", args: ["--disable-dev-shm-usage", "--no-sandbox"] },
    { args: ["--disable-dev-shm-usage", "--no-sandbox"] },
  ];
  for (const candidate of candidates) {
    try {
      const browser = await playwright.chromium.launch({
        headless: true,
        executablePath: candidate.executablePath,
        args: candidate.args,
        timeout: 15_000,
      });
      await browser.close();
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

describe("senses render", () => {
  it("renders a local fixture page through the senses server", async (ctx) => {
    const launch = await detectBrowser();
    if (!launch) ctx.skip();
    const html = `<!doctype html>
<html>
<head><title>Field notes</title></head>
<body>
<nav>skip this</nav>
<main>
  <h1>Field notes</h1>
  <p>The pier is closed.</p>
  <a href="https://example.com/tide">Tide table</a>
</main>
</body>
</html>`;
    const fixture = await listen((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    const fetchHop: FetchHop = async (url) => {
      const target = new URL(url);
      if (target.hostname === "fixture.example") target.hostname = "127.0.0.1";
      const response = await fetch(target, { redirect: "manual" });
      await response.body?.cancel();
      return { status: response.status, location: response.headers.get("location") };
    };
    const host: ResolveHost = async (name) => (name === "fixture.example" ? [PUBLIC] : [name]);
    const senses = await startSenses({
      resolveHost: host,
      fetchHop,
      executablePath: launch?.executablePath,
      launchArgs: ["--host-resolver-rules=MAP fixture.example 127.0.0.1", ...((launch?.args) ?? [])],
    });
    try {
      const result = await postSee(senses.port, { url: `http://fixture.example:${fixture.port}/notes`, screenshot: false });
      expect(result.status).toBe(200);
      expect(result.body.title).toBe("Field notes");
      expect(String(result.body.markdown)).toContain("The pier is closed.");
      expect(String(result.body.markdown)).toContain("https://example.com/tide");
      expect(result.body.links).toEqual(["https://example.com/tide"]);
      expect(result.body.png).toBeUndefined();
    } finally {
      await senses.close();
      await fixture.close();
    }
  }, 60_000);
});
