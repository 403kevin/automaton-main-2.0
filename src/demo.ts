export interface DemoReport {
  ash: string;
  brine: string;
  cinder: string;
  ashStatus: string;
  brineStatus: string;
  cinderStatus: string;
  brineBalance: string;
  cinderBalance: string;
}

export async function runDemoScenario(baseUrl: string, adminToken: string): Promise<DemoReport> {
  const before = await request(baseUrl, adminToken, "GET", "/api/overview");
  if (before.moneyMode !== "dry-run") {
    throw new Error("The demo only runs when MONEY_MODE=dry-run.");
  }
  if (before.rentUnits <= 0) {
    throw new Error("DAILY_RENT_USD must be positive so rent can actually be charged.");
  }
  const stamp = Date.now().toString(36);
  const ash = await create(baseUrl, adminToken, `ash-${stamp}`);
  const brine = await create(baseUrl, adminToken, `brine-${stamp}`);
  const cinder = await create(baseUrl, adminToken, `cinder-${stamp}`);
  await request(baseUrl, adminToken, "POST", "/admin/topup", { agentId: brine.id, usd: "5.00" });
  await request(baseUrl, adminToken, "POST", "/admin/topup", { agentId: cinder.id, usd: "3.00" });
  await request(baseUrl, adminToken, "POST", "/admin/clock", { advanceMs: before.rentIntervalMs });
  await request(baseUrl, adminToken, "POST", "/admin/clock", { advanceMs: before.graceMs + before.rentIntervalMs });
  const after = await request(baseUrl, adminToken, "GET", "/api/overview");
  const find = (id: string) => {
    const agent = after.agents.find((item: { id: string }) => item.id === id);
    if (!agent) throw new Error(`Agent ${id} disappeared from the overview.`);
    return agent;
  };
  const ashRow = find(ash.id);
  const brineRow = find(brine.id);
  const cinderRow = find(cinder.id);
  if (ashRow.status !== "archived") {
    throw new Error(`Unfunded ${ashRow.name} should be archived, status is ${ashRow.status}.`);
  }
  if (brineRow.status !== "running" || brineRow.balanceUnits <= 0) {
    throw new Error(`Topped-up ${brineRow.name} should still be running with a positive balance.`);
  }
  if (cinderRow.status !== "running" || cinderRow.balanceUnits <= 0) {
    throw new Error(`Topped-up ${cinderRow.name} should still be running with a positive balance.`);
  }
  return {
    ash: ashRow.name,
    brine: brineRow.name,
    cinder: cinderRow.name,
    ashStatus: ashRow.status,
    brineStatus: brineRow.status,
    cinderStatus: cinderRow.status,
    brineBalance: brineRow.balance,
    cinderBalance: cinderRow.balance,
  };
}

async function create(baseUrl: string, token: string, name: string): Promise<{ id: string; name: string }> {
  return request(baseUrl, token, "POST", "/admin/agents", { name });
}

async function request(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status} ${path}`);
  return payload;
}
