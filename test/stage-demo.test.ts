import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUsd } from "../src/money.js";
import { formatStageDemo, main, runStageDemo } from "../src/senses-demo.js";
import {
  type BrowseTaskRequest,
  type BrowseTaskResult,
  type CrawlSiteRequest,
  type CrawlSiteResult,
  type FeedRequest,
  type FeedResult,
  type SeePageRequest,
  type SeePageResult,
  type SensesClient,
} from "../src/senses-client.js";

const PAGE = "http://93.184.216.34/stage";

describe("stage 1 demo", () => {
  const previous = {
    BROWSE_ENABLED: process.env.BROWSE_ENABLED,
    NETWORK: process.env.NETWORK,
    ALLOW_MAINNET: process.env.ALLOW_MAINNET,
    LLM_MODE: process.env.LLM_MODE,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    SENSES_URL: process.env.SENSES_URL,
  };

  afterEach(() => {
    restore("BROWSE_ENABLED", previous.BROWSE_ENABLED);
    restore("NETWORK", previous.NETWORK);
    restore("ALLOW_MAINNET", previous.ALLOW_MAINNET);
    restore("LLM_MODE", previous.LLM_MODE);
    restore("OPENROUTER_API_KEY", previous.OPENROUTER_API_KEY);
    restore("SENSES_URL", previous.SENSES_URL);
  });

  it("debits each priced tool, records a row, and leaves browse at $0", async () => {
    process.env.BROWSE_ENABLED = "true";
    process.env.NETWORK = "base";
    process.env.ALLOW_MAINNET = "true";
    process.env.LLM_MODE = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-test";
    process.env.SENSES_URL = "http://127.0.0.1:9";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("demo tried to use the network");
    });

    try {
      const report = await runStageDemo();
      expect(report.ok, report.problems.join("\n")).toBe(true);
      expect(report.mode).toBe("mock");
      expect(report.network).toBe("base-sepolia");
      expect(report.allowMainnet).toBe(false);
      expect(report.llmMode).toBe("mock");
      expect(report.browseEnabled).toBe(false);
      expect(report.sensesCalls).toEqual(["see", "crawl", "feed"]);
      expect(fs.existsSync(report.dir)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();

      const byName = Object.fromEntries(report.rows.map((row) => [row.tool, row]));
      expect(report.rows.map((row) => row.tool)).toEqual([
        "see_page",
        "crawl_site",
        "read_feed",
        "publish_page",
        "serve_endpoint",
        "browse",
        "offer_service",
      ]);

      expect(byName.see_page?.priceUnits).toBe(parseUsd("0.002"));
      expect(byName.crawl_site?.priceUnits).toBe(parseUsd("0.001"));
      expect(byName.read_feed?.priceUnits).toBe(parseUsd("0.0005"));
      expect(byName.publish_page?.priceUnits).toBe(parseUsd("0.001"));
      expect(byName.serve_endpoint?.priceUnits).toBe(parseUsd("0.002"));
      expect(byName.offer_service?.priceUnits).toBe(parseUsd("0.001"));
      expect(byName.browse?.priceUnits).toBe(0);

      let balance = parseUsd("0.05");
      expect(report.openingUnits).toBe(balance);
      for (const row of report.rows) {
        expect(row.balanceBefore).toBe(balance);
        expect(row.balanceAfter).toBe(balance - row.priceUnits);
        expect(row.eventId != null || row.ledgerId != null).toBe(true);
        balance = row.balanceAfter;
        if (row.tool === "browse") {
          expect(row.ok).toBe(false);
          expect(row.detail).toContain("disabled by the owner");
          expect(row.eventId).toEqual(expect.any(Number));
          expect(row.ledgerId).toBeNull();
          expect(row.record).toContain(`event ${row.eventId}`);
          expect(row.record).toContain("outcome=refused");
          expect(row.record).toContain("cost=0");
          continue;
        }
        expect(row.ok).toBe(true);
        expect(row.priceUnits).toBeGreaterThan(0);
        expect(row.ledgerId).toEqual(expect.any(String));
        expect(row.record).toContain(`ledger ${row.ledgerId}`);
        if (row.tool === "offer_service") {
          expect(row.eventId).toBeNull();
          expect(row.record).toContain("note=offer_service");
          continue;
        }
        expect(row.eventId).toEqual(expect.any(Number));
        expect(row.record).toContain(`event ${row.eventId}`);
        expect(row.record).toContain("outcome=ok");
        expect(row.record).toContain(`cost=${row.priceUnits}`);
      }
      expect(report.closingUnits).toBe(balance);
      expect(report.openingUnits - report.closingUnits).toBe(parseUsd("0.0075"));

      const table = formatStageDemo(report);
      for (const tool of report.rows) {
        expect(table).toContain(tool.tool);
        expect(table).toContain(tool.record);
      }
      expect(table).toContain("mainnet locked");
      expect(table).toContain("Each sense call also writes one evidence row");
      expect(table).not.toContain("no separate evidence table");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("exits non-zero when a priced tool is refunded and writes the refusal for browse", async () => {
    const errors: string[] = [];
    const lines: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    let code = 0;
    try {
      code = await main([], { senses: new RefundingSenses() });
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
    expect(code).toBe(1);
    expect(errors.some((problem) => problem.startsWith("see_page:") && problem.includes("debit"))).toBe(true);
    expect(errors.some((problem) => problem.startsWith("browse:"))).toBe(false);
    const table = lines.join("\n");
    expect(table).toContain("see_page");
    expect(table).toContain("browse");
    expect(table).toContain("disabled by the owner");
    expect(table).not.toContain("\nok");
  });

  it("prints the table and returns 0 from the CLI entry", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
    try {
      expect(await main([])).toBe(0);
      expect(await main(["--nope"])).toBe(2);
    } finally {
      spy.mockRestore();
    }
    const printed = lines.join("\n");
    expect(printed).toContain("see_page");
    expect(printed).toContain("browse");
    expect(printed).toContain("offer_service");
    expect(printed).toContain("\nok");
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

class RefundingSenses implements SensesClient {
  async see(_input: SeePageRequest): Promise<SeePageResult> {
    throw new Error("stub down");
  }

  async crawl(input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    return {
      pages: [{ url: input.url, title: "Stub page", markdown: "Stubbed crawl text." }],
      skipped: [],
      robots: "ok",
    };
  }

  async feed(input: FeedRequest): Promise<FeedResult> {
    return {
      source: input.source,
      items: [{ source: input.source, id: "stub-1", title: "Stub item", url: PAGE, text: "Stubbed feed text." }],
      blocked: false,
      unavailable: false,
    };
  }

  async browse(_input: BrowseTaskRequest): Promise<BrowseTaskResult> {
    throw new Error("browse reached senses");
  }
}
