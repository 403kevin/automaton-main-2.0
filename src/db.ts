import { DatabaseSync } from "node:sqlite";
import type { AgentRecord, AgentStatus, PublishedPage, ServedEndpoint, ServiceOffer } from "./types.js";

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
  payer_class TEXT,
  UNIQUE(agent_id, ref)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payer_class TEXT
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

CREATE TABLE IF NOT EXISTS pages (
  agent_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  markdown TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, slug)
);

CREATE TABLE IF NOT EXISTS endpoints (
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_units INTEGER NOT NULL,
  snapshot_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT DEFAULT 'live',
  last_test_output TEXT,
  last_test_at INTEGER,
  test_failures INTEGER DEFAULT 0,
  sample_query TEXT,
  PRIMARY KEY (agent_id, name)
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'used'
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_balances (
  address TEXT PRIMARY KEY,
  units INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT,
  output_hash TEXT,
  url TEXT,
  status TEXT NOT NULL,
  threat_level TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  quarantine_path TEXT,
  raw_path TEXT
);

CREATE INDEX IF NOT EXISTS evidence_agent ON evidence(agent_id, id);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  evidence_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  threat_level TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS claims_agent ON claims(agent_id, id);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS facts_agent ON facts(agent_id, id);

CREATE TABLE IF NOT EXISTS refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS refusals_agent_time ON refusals(agent_id, created_at);

CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  op TEXT NOT NULL,
  value INTEGER NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  actual INTEGER,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS predictions_status_deadline ON predictions(status, deadline_at);

-- A prediction is immutable. The only change allowed is settlement: open to hit or miss, with the actual value and the time.
CREATE TRIGGER IF NOT EXISTS predictions_no_delete BEFORE DELETE ON predictions
BEGIN
  SELECT RAISE(ABORT, 'a prediction is immutable');
END;

CREATE TRIGGER IF NOT EXISTS predictions_no_edit BEFORE UPDATE ON predictions
WHEN OLD.status != 'open'
  OR NEW.status NOT IN ('open', 'hit', 'miss')
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.metric IS NOT OLD.metric
  OR NEW.op IS NOT OLD.op
  OR NEW.value IS NOT OLD.value
  OR NEW.note IS NOT OLD.note
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.deadline_at IS NOT OLD.deadline_at
BEGIN
  SELECT RAISE(ABORT, 'a prediction is immutable');
END;
CREATE INDEX IF NOT EXISTS ledger_agent ON ledger_entries(agent_id);
CREATE INDEX IF NOT EXISTS spend_day ON spend(day, agent_id);
`;

export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  ensureNonceStatus(db);
  ensurePayerClass(db);
  ensureEvidenceColumns(db);
  ensureEndpointColumns(db);
  return db;
}

/**
 * Add the nullable test columns an older endpoints table lacks (BO-2.2). A null status reads as live and a null
 * failure count as 0, so rows made before this keep working. Safe to run on every open.
 */
function ensureEndpointColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(endpoints)").all() as unknown as { name: string }[];
  const wanted: Array<[string, string]> = [
    ["status", "TEXT DEFAULT 'live'"],
    ["last_test_output", "TEXT"],
    ["last_test_at", "INTEGER"],
    ["test_failures", "INTEGER DEFAULT 0"],
    ["sample_query", "TEXT"],
  ];
  for (const [name, type] of wanted) {
    if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE endpoints ADD COLUMN ${name} ${type}`);
  }
}

/**
 * Add the nullable evidence columns an older table lacks: quarantine_path (BO-2.1-fix) and raw_path (BO-2.1c).
 * Safe to run on every open.
 */
function ensureEvidenceColumns(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(evidence)").all() as unknown as { name: string }[];
  for (const name of ["quarantine_path", "raw_path"]) {
    if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE evidence ADD COLUMN ${name} TEXT`);
  }
}

/** A pending reservation older than this is a crashed handler, not a live payment. */
export const NONCE_PENDING_TTL_MS = 60_000;

const REPLAY = "Payment nonce was already used.";

function ensureNonceStatus(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(nonces)").all() as unknown as { name: string }[];
  if (!cols.some((col) => col.name === "status")) {
    db.exec("ALTER TABLE nonces ADD COLUMN status TEXT NOT NULL DEFAULT 'used'");
  }
}

/**
 * Add payer_class to ledgers created before inbound payments were tagged.
 * The column is nullable. Existing rows stay NULL, and accounting treats that as outside.
 * A new row is 'outside' or 'sibling'. This does not rewrite balances.
 */
function ensurePayerClass(db: DatabaseSync): void {
  ensureColumn(db, "ledger_entries", "payer_class", "ALTER TABLE ledger_entries ADD COLUMN payer_class TEXT");
  ensureColumn(db, "events", "payer_class", "ALTER TABLE events ADD COLUMN payer_class TEXT");
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((col) => col.name === column)) db.exec(ddl);
}

/**
 * Reserve a nonce as pending inside one immediate transaction.
 * The primary key is the lock: a second pending or used nonce fails before any handler starts.
 * Pending rows older than 60s are deleted first so a crash cannot stick the buyer.
 */
export function reservePaymentNonce(
  db: DatabaseSync,
  nonce: string,
  now: number,
): { ok: true } | { ok: false; error: string } {
  if (!nonce || nonce.length > 200) return { ok: false, error: REPLAY };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM nonces WHERE status = 'pending' AND created_at <= ?").run(now - NONCE_PENDING_TTL_MS);
    const legacy = db.prepare("SELECT value FROM kv WHERE key = ?").get(`nonce:${nonce}`) as { value: string } | undefined;
    if (legacy) {
      db.exec("ROLLBACK");
      return { ok: false, error: REPLAY };
    }
    const row = db.prepare("SELECT status FROM nonces WHERE nonce = ?").get(nonce) as { status: string } | undefined;
    if (row) {
      db.exec("ROLLBACK");
      return { ok: false, error: REPLAY };
    }
    db.prepare("INSERT INTO nonces (nonce, created_at, status) VALUES (?, ?, 'pending')").run(nonce, now);
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction was already closed.
    }
    const message = error instanceof Error ? error.message : "Could not reserve the payment nonce.";
    if (/UNIQUE|constraint/i.test(message)) return { ok: false, error: REPLAY };
    return { ok: false, error: message };
  }
}

/** Drop a pending reservation so the buyer can retry. Used rows stay. */
export function releasePaymentNonce(db: DatabaseSync, nonce: string): void {
  db.prepare("DELETE FROM nonces WHERE nonce = ? AND status = 'pending'").run(nonce);
}

export function releaseStalePaymentNonces(db: DatabaseSync, now: number): number {
  const result = db
    .prepare("DELETE FROM nonces WHERE status = 'pending' AND created_at <= ?")
    .run(now - NONCE_PENDING_TTL_MS);
  return Number(result.changes);
}

/** Call inside the same transaction as the ledger credit. Throws if the nonce is not pending. */
export function markNonceUsed(db: DatabaseSync, nonce: string, now: number): void {
  const result = db
    .prepare("UPDATE nonces SET status = 'used', created_at = ? WHERE nonce = ? AND status = 'pending'")
    .run(now, nonce);
  if (result.changes !== 1) throw new Error(REPLAY);
  db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(`nonce:${nonce}`);
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

export function listPages(db: DatabaseSync, agentId: string): PublishedPage[] {
  const rows = db
    .prepare("SELECT slug, markdown, updated_at FROM pages WHERE agent_id = ? ORDER BY slug ASC")
    .all(agentId) as unknown as { slug: string; markdown: string; updated_at: number }[];
  return rows.map((row) => ({ slug: row.slug, markdown: row.markdown, updatedAt: row.updated_at }));
}

export function getPage(db: DatabaseSync, agentId: string, slug: string): PublishedPage | undefined {
  const row = db
    .prepare("SELECT slug, markdown, updated_at FROM pages WHERE agent_id = ? AND slug = ?")
    .get(agentId, slug) as { slug: string; markdown: string; updated_at: number } | undefined;
  if (!row) return undefined;
  return { slug: row.slug, markdown: row.markdown, updatedAt: row.updated_at };
}

export function countPages(db: DatabaseSync, agentId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM pages WHERE agent_id = ?").get(agentId) as { n: number };
  return row.n;
}

interface EndpointRow {
  name: string;
  price_units: number;
  snapshot_hash: string;
  updated_at: number;
  status: string | null;
  last_test_output: string | null;
  last_test_at: number | null;
  test_failures: number | null;
  sample_query: string | null;
}

const ENDPOINT_COLUMNS =
  "name, price_units, snapshot_hash, updated_at, status, last_test_output, last_test_at, test_failures, sample_query";

function parseSampleQuery(text: string | null): Record<string, string> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === "string") query[key] = value;
    return query;
  } catch {
    return {};
  }
}

function endpointFromRow(row: EndpointRow): ServedEndpoint {
  return {
    name: row.name,
    priceUnits: row.price_units,
    snapshotHash: row.snapshot_hash,
    updatedAt: row.updated_at,
    status: row.status === "unpublished" ? "unpublished" : "live",
    lastTestOutput: row.last_test_output,
    lastTestAt: row.last_test_at,
    testFailures: row.test_failures ?? 0,
    sampleQuery: parseSampleQuery(row.sample_query),
  };
}

export function listEndpoints(db: DatabaseSync, agentId: string): ServedEndpoint[] {
  const rows = db
    .prepare(`SELECT ${ENDPOINT_COLUMNS} FROM endpoints WHERE agent_id = ? ORDER BY name ASC`)
    .all(agentId) as unknown as EndpointRow[];
  return rows.map(endpointFromRow);
}

export function getEndpoint(db: DatabaseSync, agentId: string, name: string): ServedEndpoint | undefined {
  const row = db
    .prepare(`SELECT ${ENDPOINT_COLUMNS} FROM endpoints WHERE agent_id = ? AND name = ?`)
    .get(agentId, name) as EndpointRow | undefined;
  return row ? endpointFromRow(row) : undefined;
}

export function countEndpoints(db: DatabaseSync, agentId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM endpoints WHERE agent_id = ?").get(agentId) as { n: number };
  return row.n;
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
