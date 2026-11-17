import { buildApp } from "./app.js";
import { runDemoScenario } from "./demo.js";
import { redact } from "./redact.js";
import { startServer } from "./server.js";

export async function main(argv: string[]): Promise<void> {
  const [command = "serve", ...rest] = argv;
  if (command === "serve") {
    const app = await buildApp(process.env);
    const server = await startServer(app);
    console.log(`Automaton is serving ${server.url}`);
    console.log(`Money ${app.config.moneyMode} on ${app.config.network}. Runtime ${app.config.runtime}.`);
    const shutdown = () => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  if (command === "demo") {
    await demo(rest.includes("--check"));
    return;
  }
  if (command === "topup") {
    const [agentId, usd] = rest;
    if (!agentId || !usd) throw new Error("Usage: automaton topup <agentId> <usd>");
    const result = await client("POST", "/admin/topup", { agentId, usd });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await client("GET", "/api/overview"), null, 2));
    return;
  }
  if (command === "kill") {
    console.log(JSON.stringify(await client("POST", "/admin/kill-switch", { enabled: true }), null, 2));
    return;
  }
  if (command === "resume") {
    console.log(JSON.stringify(await client("POST", "/admin/kill-switch", { enabled: false }), null, 2));
    return;
  }
  if (command === "deposit") {
    const [agentId, usd] = rest;
    if (!agentId || !usd) throw new Error("Usage: automaton deposit <agentId> <usd>");
    console.log(JSON.stringify(await client("POST", "/admin/simulate-transfer", { agentId, usd }), null, 2));
    return;
  }
  throw new Error("Commands: serve, demo [--check], status, topup <agentId> <usd>, deposit <agentId> <usd>, kill, resume");
}

async function demo(check: boolean): Promise<void> {
  const port = process.env.PORT ?? "4747";
  const url = process.env.AUTOMATON_URL ?? `http://127.0.0.1:${port}`;
  const already = await healthy(url);
  let close: (() => Promise<void>) | null = null;
  let token = process.env.ADMIN_TOKEN ?? "";
  if (!already) {
    const app = await buildApp(process.env);
    const server = await startServer(app);
    close = () => server.close();
    token = app.config.adminToken;
    console.log(`Automaton is serving ${server.url}`);
  }
  if (!token) throw new Error("ADMIN_TOKEN is required to drive a server that is already running.");
  try {
    const report = await runDemoScenario(already ? url : `http://127.0.0.1:${port}`, token);
    console.log(
      [
        "Demo clock advanced through rent and grace.",
        `${report.ash}: ${report.ashStatus} (unfunded, archived)`,
        `${report.brine}: ${report.brineStatus} at ${report.brineBalance}`,
        `${report.cinder}: ${report.cinderStatus} at ${report.cinderBalance}`,
        `Dashboard ${already ? url : `http://127.0.0.1:${port}`}/`,
      ].join("\n"),
    );
  } catch (error) {
    if (close && check) await close();
    throw error;
  }
  if (check) {
    if (close) await close();
    process.exit(0);
  }
}

async function client(method: string, path: string, body?: unknown): Promise<unknown> {
  const base = process.env.AUTOMATON_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4747"}`;
  const token = process.env.ADMIN_TOKEN ?? "";
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(redact(payload.error || `HTTP ${response.status}`));
  return payload;
}

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}
