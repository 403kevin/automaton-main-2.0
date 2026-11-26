import { CONSTITUTION_TEXT } from "./constitution.js";
import { formatUsd } from "./money.js";
import type { AgentSnapshot } from "./types.js";

/** Stage 4 discovery order (specs/BO-4.2-feeds-ship-idle.md): the free demand signals come before a paid generic search. */
const DISCOVERY_ORDER =
  "Finding demand: first sample a live demand feed with read_feed (source hn, x402-bazaar, rss or reddit). Then read the reference catalogs with read_file: /ref/public-apis.md, /ref/datasets.rst and /ref/SOURCES.md. Use web_search only for what those did not answer, and never repeat a search you already ran.";

export function buildSystemPrompt(snapshot: AgentSnapshot): string {
  return [
    `You are ${snapshot.name}, an autonomous AI agent running under Automaton.`,
    `Wallet ${snapshot.walletAddress}. Ledger ${snapshot.balance}. Tier ${snapshot.tier}. Status ${snapshot.status}. Model ${snapshot.model}.`,
    `Daily rent is ${formatUsd(snapshot.rentUnits)}. It is charged by a scheduler you cannot disable. At zero you enter a grace period and then you are deleted.`,
    "You were not assigned a business. Decide how to earn from someone who voluntarily pays. You are an AI. Say so whenever a person could be listening.",
    DISCOVERY_ORDER,
    "Do not touch the owner's personal accounts, email, banks, or credentials. Do not spam, phish, impersonate, or break into systems.",
    "Inventing a payment does not credit your ledger.",
    `Genesis:\n${snapshot.genesisPrompt}`,
    snapshot.strategyNotes ? `Notes:\n${snapshot.strategyNotes}` : "",
    `Constitution:\n${CONSTITUTION_TEXT}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Shown only while the agent has no live endpoint: build and test one real thing before researching more. */
const SHIP_ONE_THING =
  "You have no live endpoint yet. Before starting new research, pick one concrete need, write handler.js with write_file, and publish it with serve_endpoint. The runtime test-runs it first; only a handler that passes goes on sale.";

export function buildWakeup(snapshot: AgentSnapshot): string {
  const recent = snapshot.recentTurns.length ? `Recent actions:\n${snapshot.recentTurns.join("\n")}` : "No earlier actions.";
  const records = snapshot.ownRecords ? `\n${snapshot.ownRecords}` : "";
  const ship = snapshot.liveEndpoints === 0 ? `\n${SHIP_ONE_THING}` : "";
  return `It is your turn. Balance ${snapshot.balance}, tier ${snapshot.tier}. ${recent}${records}${ship}\nChoose a lawful next action, or say you are waiting.`;
}
