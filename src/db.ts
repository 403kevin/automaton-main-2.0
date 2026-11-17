import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, AgentStatus, ServiceOffer } from "./types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  depth INTEGER NOT NULL,
  status TEXT NOT NULL,
  genesis_prompt TEXT NOT NULL,
  strategy_notes TEXT NOT NULL,
  model TEXT,
  low_model TEXT,
  critical_model TEXT,
  wallet_address TEXT NOT NULL,
  wallet_ciphertext TEXT NOT NULL,
  container_id TEXT,
  grace_until INTEGER,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  balance_units INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  last_action TEXT,
  last_log_block TEXT,
  workspace TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, ref)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  amount_units INTEGER NOT NULL,
  category TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  agent_id TEXT PRIMARY KEY,
  price_units INTEGER NOT NULL,
  description TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_balances (
  address TEXT PRIMARY KEY,
  units INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_agent ON ledger_entries(agent_id);
CREATE INDEX IF NOT EXISTS spend_day ON spend(day, agent_id);
`;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

interface AgentRow {
  id: string;
  name: string;
  parent_id: string | null;
  depth: number;
  status: string;
  genesis_prompt: string;
  strategy_notes: string;
  model: string | null;
  low_model: string | null;
  critical_model: string | null;
  wallet_address: string;
  wallet_ciphertext: string;
  container_id: string | null;
  grace_until: number | null;
  created_at: number;
  archived_at: number | null;
  balance_units: number;
  token_hash: string;
  last_action: string | null;
  last_log_block: string | null;
  workspace: string;
}

export function mapAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    depth: row.depth,
    status: row.status as AgentStatus,
    genesisPrompt: row.genesis_prompt,
    strategyNotes: row.strategy_notes,
    model: row.model,
    lowModel: row.low_model,
    criticalModel: row.critical_model,
    walletAddress: row.wallet_address,
    walletCiphertext: row.wallet_ciphertext,
    containerId: row.container_id,
    graceUntil: row.grace_until,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    balanceUnits: row.balance_units,
    tokenHash: row.token_hash,
    lastAction: row.last_action,
    lastLogBlock: row.last_log_block,
    workspace: row.workspace,
  };
}

export function getAgent(db: DatabaseSync, id: string): AgentRecord | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
  return row ? mapAgent(row) : undefined;
}

export function getAgentByAddress(db: DatabaseSync, address: string): AgentRecord | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE lower(wallet_address) = lower(?)").get(address) as
    | AgentRow
    | undefined;
  return row ? mapAgent(row) : undefined;
}

export function listAgents(db: DatabaseSync): AgentRecord[] {
  const rows = db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all() as unknown as AgentRow[];
  return rows.map(mapAgent);
}

export function getService(db: DatabaseSync, agentId: string): ServiceOffer | undefined {
  const row = db
    .prepare("SELECT price_units, description, body FROM services WHERE agent_id = ?")
    .get(agentId) as { price_units: number; description: string; body: string } | undefined;
  if (!row) return undefined;
  return { priceUnits: row.price_units, description: row.description, body: row.body };
}

export function kvGet(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}
