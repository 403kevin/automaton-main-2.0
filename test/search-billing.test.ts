import { afterEach, describe, expect, it } from "vitest";
import type { SearchHit, SearchProvider } from "../src/search.js";
import { parseUsd } from "../src/money.js";
import { harness } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

class CountingSearch implements SearchProvider {
  calls = 0;
  async search(): Promise<SearchHit[]> {
    this.calls += 1;
    return [{ title: "Result", url: "https://example.com", snippet: "A public page." }];
  }
}

describe("search billing", () => {
  it("charges a successful search and does not call the provider when the cap blocks it", async () => {
    const search = new CountingSearch();
    const rig = harness({ AGENT_DAILY_CAP_USD: "0.002", GLOBAL_DAILY_CAP_USD: "0.002", SEARCH_COST_USD: "0.002" }, undefined, search);
    cleanups.push(rig.cleanup);
    const agent = await rig.swarm.createAgent({ name: "scout" });
    if (!agent.ok) throw new Error(agent.error);
    rig.swarm.ownerTopup(agent.value.id, parseUsd("1"), "seed");
    const first = await rig.swarm.handleTool(agent.value.id, {
      id: "search-1",
      name: "web_search",
      arguments: { query: "lawful paid work" },
    });
    expect(first.ok).toBe(true);
    expect(search.calls).toBe(1);
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBe(parseUsd("1") - parseUsd("0.002"));
    const second = await rig.swarm.handleTool(agent.value.id, {
      id: "search-2",
      name: "web_search",
      arguments: { query: "another query" },
    });
    expect(second.ok).toBe(false);
    expect(search.calls).toBe(1);
    expect(rig.swarm.snapshot(agent.value.id).balanceUnits).toBe(parseUsd("1") - parseUsd("0.002"));
  });
});
