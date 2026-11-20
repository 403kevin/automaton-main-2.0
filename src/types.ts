export type AgentStatus = "running" | "grace" | "archived";
export type Tier = "normal" | "low_compute" | "critical";
export type SpendCategory = "inference" | "tool" | "council" | "x402" | "replication";

export type LedgerKind =
  | "owner_topup"
  | "onchain_income"
  | "x402_in"
  | "inference"
  | "tool"
  | "council"
  | "rent"
  | "replication_out"
  | "replication_in"
  | "x402_out"
  | "sweep";

export interface AgentRecord {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  status: AgentStatus;
  genesisPrompt: string;
  strategyNotes: string;
  model: string | null;
  lowModel: string | null;
  criticalModel: string | null;
  walletAddress: string;
  walletCiphertext: string;
  containerId: string | null;
  graceUntil: number | null;
  createdAt: number;
  archivedAt: number | null;
  balanceUnits: number;
  tokenHash: string;
  lastAction: string | null;
  lastLogBlock: string | null;
  workspace: string;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  status: AgentStatus;
  tier: Tier;
  model: string;
  balanceUnits: number;
  balance: string;
  genesisPrompt: string;
  strategyNotes: string;
  killSwitch: boolean;
  walletAddress: string;
  rentUnits: number;
  graceUntil: number | null;
  recentTurns: string[];
  /** The agent's own latest facts and claims in one fenced block, or empty. Own rows only. */
  ownRecords?: string;
}

export interface ServiceOffer {
  priceUnits: number;
  description: string;
  body: string;
}

export interface PublishedPage {
  slug: string;
  markdown: string;
  updatedAt: number;
}

export type EndpointStatus = "live" | "unpublished";

export interface ServedEndpoint {
  name: string;
  priceUnits: number;
  snapshotHash: string;
  updatedAt: number;
  status: EndpointStatus;
  /** The runtime's own recording of the last test run (never agent-written text). */
  lastTestOutput: string | null;
  lastTestAt: number | null;
  /** Consecutive failed re-tests. */
  testFailures: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
