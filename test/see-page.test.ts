import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUsd } from "../src/money.js";
import {
  SensesRequestError,
  type CrawlSiteRequest,
  type CrawlSiteResult,
  type FeedRequest,
  type FeedResult,
  type SeePageRequest,
  type SeePageResult,
  type SensesClient,
} from "../src/senses-client.js";
import { harness } from "./helpers.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PAGE = "http://93.184.216.34/page";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

class Probe implements SensesClient {
  calls = 0;
  balanceAtCall: number[] = [];
  mode: "ok" | "throw" | "refuse" = "ok";

  constructor(private readonly balance: () => number) {}

  async crawl(_input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    throw new Error("crawl was not stubbed");
  }

  async feed(_input: FeedRequest): Promise<FeedResult> {
    throw new Error("feed was not stubbed");
  }

  async see(input: SeePageRequest): Promise<SeePageResult> {
    this.calls += 1;
    this.balanceAtCall.push(this.balance());
    if (this.mode === "throw") throw new Error("browser crashed");
    if (this.mode === "refuse") throw new SensesRequestError("redirected to a private address", 400);
    return {
      title: "Example",
      markdown: "Hello from the page.",
      links: ["https://example.com/a"],
      png: input.screenshot ? PNG : undefined,
    };
  }
}

function rigWithProbe(overrides: Record<string, string> = {}) {
  let read = () => 0;
  const probe = new Probe(() => read());
  const rig = harness(overrides, undefined, undefined, probe);
  cleanups.push(rig.cleanup);
  return {
    rig,
    probe,
    bind(agentId: string) {
      read = () => rig.swarm.snapshot(agentId).balanceUnits;
    },
  };
}

async function funded(overrides: Record<string, string> = {}) {
  const box = rigWithProbe(overrides);
  const created = await box.rig.swarm.createAgent({ name: "scout" });
  if (!created.ok) throw new Error(created.error);
  box.rig.swarm.ownerTopup(created.value.id, parseUsd("1"), "seed");
  box.bind(created.value.id);
  return { ...box, id: created.value.id };
}

function seeEvents(rig: ReturnType<typeof harness>, agentId: string): { kind: string; message: string }[] {
  return rig.db
    .prepare("SELECT kind, message FROM events WHERE agent_id = ? AND kind = 'see_page' ORDER BY id")
    .all(agentId) as { kind: string; message: string }[];
}

describe("see_page ledger", () => {
  it("prices the call and points at the senses service", () => {
    const { rig } = rigWithProbe();
    expect(rig.config.sensesUrl).toBe("http://senses:7070");
    expect(rig.config.seePagePriceUnits).toBe(parseUsd("0.002"));
    expect(rig.config.seePageScreenshotPriceUnits).toBe(parseUsd("0.003"));
    expect(rig.config.seePageHourlyLimit).toBe(30);
    expect(rig.config.toolCosts.see_page).toBe(parseUsd("0.002"));
  });

  it("reviews the url before charging, so a private address leaves the balance unchanged", async () => {
    const { rig, probe, id } = await funded();
    const before = rig.swarm.snapshot(id).balanceUnits;
    const refused = await rig.swarm.handleTool(id, {
      id: "see-private",
      name: "see_page",
      arguments: { url: "http://10.0.0.1/latest" },
    });
    const metadata = await rig.swarm.handleTool(id, {
      id: "see-metadata",
      name: "see_page",
      arguments: { url: "http://169.254.169.254/latest/meta-data" },
    });
    expect(refused.ok).toBe(false);
    expect(metadata.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/private|link-local/i);
    if (!metadata.ok) expect(metadata.reason).toMatch(/private|link-local/i);
    expect(probe.calls).toBe(0);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(before);
    const events = seeEvents(rig, id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.message.includes("outcome=refused") && event.message.includes("cost=0"))).toBe(true);
  });

  it("debits before the senses call, and refunds when senses refuses or errors", async () => {
    const { rig, probe, id } = await funded();
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.002");
    const ok = await rig.swarm.handleTool(id, {
      id: "see-ok",
      name: "see_page",
      arguments: { url: PAGE },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.output).toContain("Hello from the page.");
    expect(probe.calls).toBe(1);
    expect(probe.balanceAtCall[0]).toBe(start - price);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);
    expect(seeEvents(rig, id).some((event) => event.message.includes("outcome=ok") && event.message.includes(`cost=${price}`) && event.message.includes(PAGE))).toBe(true);

    probe.mode = "refuse";
    const refused = await rig.swarm.handleTool(id, {
      id: "see-refuse",
      name: "see_page",
      arguments: { url: PAGE },
    });
    expect(refused.ok).toBe(false);
    expect(probe.calls).toBe(2);
    expect(probe.balanceAtCall[1]).toBe(start - price * 2);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);

    probe.mode = "throw";
    const crashed = await rig.swarm.handleTool(id, {
      id: "see-crash",
      name: "see_page",
      arguments: { url: PAGE },
    });
    expect(crashed.ok).toBe(false);
    if (!crashed.ok) expect(crashed.reason).toContain("browser crashed");
    expect(probe.calls).toBe(3);
    expect(probe.balanceAtCall[2]).toBe(start - price * 2);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price);
    const spent = rig.db.prepare("SELECT COALESCE(SUM(amount_units), 0) AS n FROM spend WHERE agent_id = ?").get(id) as { n: number };
    expect(spent.n).toBe(price);
  });

  it("charges the screenshot extra and writes the png under evidence/", async () => {
    const { rig, probe, id } = await funded();
    const start = rig.swarm.snapshot(id).balanceUnits;
    const cost = parseUsd("0.002") + parseUsd("0.003");
    const seen = await rig.swarm.handleTool(id, {
      id: "see-shot",
      name: "see_page",
      arguments: { url: PAGE, screenshot: true },
    });
    expect(seen.ok).toBe(true);
    expect(probe.balanceAtCall[0]).toBe(start - cost);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - cost);
    const agent = rig.db.prepare("SELECT workspace FROM agents WHERE id = ?").get(id) as { workspace: string };
    const files = fs.readdirSync(path.join(agent.workspace, "evidence"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-[0-9a-f]{8}\.png$/);
    const saved = fs.readFileSync(path.join(agent.workspace, "evidence", files[0]));
    expect(saved.equals(Buffer.from(PNG, "base64"))).toBe(true);
    if (seen.ok) expect(seen.output).toContain(`evidence/${files[0]}`);
    expect(seeEvents(rig, id)[0]?.message).toContain(`evidence=evidence/${files[0]}`);
  });

  it("refuses the hourly limit without charging", async () => {
    const { rig, probe, id } = await funded({ SEE_PAGE_HOURLY_LIMIT: "2" });
    const start = rig.swarm.snapshot(id).balanceUnits;
    const price = parseUsd("0.002");
    for (const callId of ["h1", "h2"]) {
      const seen = await rig.swarm.handleTool(id, { id: callId, name: "see_page", arguments: { url: PAGE } });
      expect(seen.ok).toBe(true);
    }
    const blocked = await rig.swarm.handleTool(id, { id: "h3", name: "see_page", arguments: { url: PAGE } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toContain("hourly limit is 2");
    expect(probe.calls).toBe(2);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 2);
    rig.clock.advance(3_600_000);
    const again = await rig.swarm.handleTool(id, { id: "h4", name: "see_page", arguments: { url: PAGE } });
    expect(again.ok).toBe(true);
    expect(probe.calls).toBe(3);
    expect(rig.swarm.snapshot(id).balanceUnits).toBe(start - price * 3);
  });

  it("refuses a host on CONSTITUTION_DENY_HOSTS before charging", async () => {
    const prior = process.env.CONSTITUTION_DENY_HOSTS;
    process.env.CONSTITUTION_DENY_HOSTS = "blocked.example";
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      const { rig, probe, id } = await funded();
      const before = rig.swarm.snapshot(id).balanceUnits;
      const refused = await rig.swarm.handleTool(id, {
        id: "see-deny",
        name: "see_page",
        arguments: { url: "https://news.blocked.example/story" },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("blocked.example");
      expect(probe.calls).toBe(0);
      expect(rig.swarm.snapshot(id).balanceUnits).toBe(before);
      expect(logs.some((line) => line.includes("constitution deny"))).toBe(true);
      expect(seeEvents(rig, id).some((event) => event.message.includes("outcome=refused") && event.message.includes("cost=0"))).toBe(true);
    } finally {
      spy.mockRestore();
      if (prior === undefined) delete process.env.CONSTITUTION_DENY_HOSTS;
      else process.env.CONSTITUTION_DENY_HOSTS = prior;
    }
  });
});
