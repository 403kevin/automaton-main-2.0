export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Automaton</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #12100c; color: #f3ecdf; font-family: "Avenir Next", "Segoe UI", sans-serif; }
  header, main { width: min(1100px, calc(100% - 32px)); margin: 0 auto; }
  header { padding: 36px 0 12px; display: flex; justify-content: space-between; gap: 24px; align-items: end; border-top: 4px solid #d9783a; }
  h1 { font-family: Palatino, "Iowan Old Style", Georgia, serif; font-weight: 500; font-size: 52px; margin: 0; letter-spacing: -0.03em; }
  h2 { font-family: Palatino, Georgia, serif; font-weight: 500; font-size: 28px; margin: 28px 0 12px; }
  .eyebrow { letter-spacing: 0.16em; text-transform: uppercase; font-size: 12px; color: #d9783a; margin: 0 0 8px; }
  .lede { max-width: 62ch; color: #cbbfa8; line-height: 1.45; }
  .badges { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
  .badge { border: 1px solid #3a3328; padding: 6px 10px; border-radius: 999px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  .badge.warn { border-color: #d9783a; color: #f0c08a; }
  .badge.dead { border-color: #e07a5f; color: #f0b2a4; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .stat, .card, .panel, .event { background: #1c1914; border: 1px solid #3a3328; border-radius: 14px; }
  .stat { padding: 14px 16px; }
  .stat span { display: block; color: #a39882; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; }
  .stat strong { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 20px; font-weight: 500; }
  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
  .card { padding: 16px 18px; }
  .card header { width: auto; margin: 0; padding: 0; border: 0; display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .name { font-family: Palatino, Georgia, serif; font-size: 28px; margin: 0; }
  .meta { color: #a39882; font-size: 13px; }
  .nums { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0; }
  .nums div { background: #14120e; border-radius: 10px; padding: 8px 10px; }
  .nums span { display: block; color: #a39882; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .nums b { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 500; }
  .alive { color: #d6e27a; }
  .grace { color: #f0c08a; }
  .archived { color: #e07a5f; }
  ul { margin: 8px 0 0; padding-left: 18px; color: #d9d0c1; }
  .panel { padding: 16px; display: grid; gap: 10px; }
  label { display: grid; gap: 4px; font-size: 13px; color: #cbbfa8; }
  input, textarea, button { font: inherit; color: inherit; background: #12100c; border: 1px solid #3a3328; border-radius: 10px; padding: 8px 10px; }
  textarea { min-height: 72px; }
  button { background: #d9783a; color: #1a1008; border: 0; cursor: pointer; font-weight: 600; }
  button.ghost { background: transparent; color: #f3ecdf; border: 1px solid #3a3328; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; }
  .event { padding: 8px 12px; margin: 0 0 8px; }
  .event time, .event em { color: #a39882; font-style: normal; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
  pre.panel { white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; line-height: 1.45; }
  #notice { min-height: 1.2em; color: #f0c08a; }
  @media (max-width: 800px) {
    header { flex-direction: column; align-items: start; }
    h1 { font-size: 40px; }
    .stats, .nums { grid-template-columns: 1fr 1fr; }
    .badges { justify-content: flex-start; }
  }
</style>
</head>
<body>
<header>
  <div>
    <p class="eyebrow">Self-hosted swarm</p>
    <h1>Automaton</h1>
    <p class="lede">Each agent pays rent from its ledger or it is deleted. Nobody assigned them a business. Verified on-chain transfers and owner top-ups are the only income. Claims are ignored.</p>
  </div>
  <div class="badges" id="badges"></div>
</header>
<main>
  <p id="notice">Reading the ledger…</p>
  <section class="stats" id="stats"></section>
  <h2>Agents</h2>
  <div class="grid" id="agents"></div>
  <h2>Owner</h2>
  <form class="panel" id="admin">
    <label>Admin token <input id="token" type="password" autocomplete="current-password"/></label>
    <div class="row">
      <label>Name <input id="name" placeholder="keeper"/></label>
      <label>Top-up USD <input id="usd" placeholder="5.00"/></label>
      <label>Agent id <input id="agentId" placeholder="a…"/></label>
    </div>
    <label>Genesis <textarea id="genesis" placeholder="Leave blank to use the default survival prompt. Do not paste a business plan unless you mean to."></textarea></label>
    <div class="row">
      <button type="button" id="create">Create agent</button>
      <button type="button" id="topup">Top up</button>
      <button type="button" class="ghost" id="kill">Toggle kill switch</button>
      <button type="button" class="ghost" id="deposit">Dry-run USDC deposit</button>
    </div>
  </form>
  <h2>Daily report</h2>
  <pre id="report" class="panel">No report yet.</pre>
  <h2>Event log</h2>
  <div id="events"></div>
</main>
<script>
const tokenInput = document.querySelector("#token");
tokenInput.value = sessionStorage.getItem("automaton-admin") || "";
tokenInput.addEventListener("change", () => sessionStorage.setItem("automaton-admin", tokenInput.value));
const notice = document.querySelector("#notice");
let latest = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function badge(text, className) {
  const node = el("span", text, "badge" + (className ? " " + className : ""));
  document.querySelector("#badges").append(node);
}
function stat(label, value) {
  const node = el("div", "", "stat");
  node.append(el("span", label), el("strong", value));
  document.querySelector("#stats").append(node);
}
function render(data) {
  latest = data;
  notice.textContent = "";
  const badges = document.querySelector("#badges");
  const stats = document.querySelector("#stats");
  const agents = document.querySelector("#agents");
  const events = document.querySelector("#events");
  const report = document.querySelector("#report");
  badges.replaceChildren();
  stats.replaceChildren();
  agents.replaceChildren();
  events.replaceChildren();
  badge(data.moneyMode + " · " + data.network, data.moneyMode === "live" && data.network === "base" ? "dead" : "warn");
  badge(data.killSwitch ? "kill switch ON" : "kill switch off", data.killSwitch ? "dead" : "");
  badge(data.llmMode + " llm");
  stat("Population", data.population + " / " + data.maxPopulation);
  stat("Global spend today", data.globalSpend);
  stat("Global cap", data.globalCap);
  stat("Daily rent", data.rent);
  if (data.agents.length === 0) {
    agents.append(el("p", "No agents yet. Paste the admin token, name one, and create it. Or run npm run demo.", "lede"));
  }
  for (const agent of data.agents) {
    const card = el("article", "", "card");
    const head = document.createElement("header");
    head.append(el("h3", agent.name, "name"));
    head.append(el("div", agent.status + " · " + agent.tier, agent.status));
    card.append(head);
    const nums = el("div", "", "nums");
    for (const [label, value] of [["Balance", agent.balance], ["Verified income", agent.income], ["Subsidy", agent.subsidy], ["Spend", agent.spend], ["Rent charged", agent.rentCharged], ["Rent due", agent.rentDue], ["Depth", String(agent.depth)], ["Children", String(agent.children.length)]]) {
      const cell = document.createElement("div");
      cell.append(el("span", label), el("b", value));
      nums.append(cell);
    }
    card.append(nums);
    card.append(el("p", agent.walletAddress, "meta"));
    card.append(el("p", "Model " + agent.model + (agent.containerId ? " · " + agent.containerId : ""), "meta"));
    if (agent.graceUntil) card.append(el("p", "Grace until " + new Date(agent.graceUntil).toISOString(), "meta"));
    const actions = document.createElement("ul");
    const list = agent.lastActions.length ? agent.lastActions : (agent.lastAction ? [{ text: agent.lastAction }] : []);
    if (list.length === 0) actions.append(el("li", "No actions recorded."));
    for (const action of list) actions.append(el("li", action.text));
    card.append(actions);
    if (agent.children.length) {
      card.append(el("p", "Children: " + agent.children.map((child) => child.name + " (" + child.status + ")").join(", "), "meta"));
    }
    agents.append(card);
  }
  report.textContent = data.dailyReport || "No daily report yet. The orchestrator writes one on boot and then once a day.";
  if (data.events.length === 0) events.append(el("p", "The log is empty.", "lede"));
  for (const event of data.events) {
    const row = el("div", "", "event");
    row.append(el("time", new Date(event.at).toISOString() + " "));
    row.append(el("em", (event.agentId || "swarm") + " · " + event.kind + " "));
    row.append(document.createTextNode(event.message));
    events.append(row);
  }
}

async function load() {
  try {
    const response = await fetch("/api/overview");
    if (!response.ok) throw new Error("HTTP " + response.status);
    render(await response.json());
  } catch (error) {
    notice.textContent = "The orchestrator is not answering. " + (error && error.message ? error.message : "");
  }
}

async function admin(path, body) {
  const token = tokenInput.value.trim();
  sessionStorage.setItem("automaton-admin", token);
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
  return payload;
}

document.querySelector("#create").onclick = async () => {
  try {
    const payload = await admin("/admin/agents", { name: document.querySelector("#name").value, genesisPrompt: document.querySelector("#genesis").value });
    notice.textContent = "Created " + payload.name + " at " + payload.address;
    await load();
  } catch (error) { notice.textContent = error.message; }
};
document.querySelector("#topup").onclick = async () => {
  try {
    await admin("/admin/topup", { agentId: document.querySelector("#agentId").value, usd: document.querySelector("#usd").value });
    notice.textContent = "Top-up recorded.";
    await load();
  } catch (error) { notice.textContent = error.message; }
};
document.querySelector("#kill").onclick = async () => {
  try {
    const enabled = !(latest && latest.killSwitch);
    await admin("/admin/kill-switch", { enabled });
    notice.textContent = enabled ? "Kill switch is on. Agents are stopped." : "Kill switch is off.";
    await load();
  } catch (error) { notice.textContent = error.message; }
};
document.querySelector("#deposit").onclick = async () => {
  try {
    await admin("/admin/simulate-transfer", { agentId: document.querySelector("#agentId").value, usd: document.querySelector("#usd").value });
    notice.textContent = "Dry-run USDC deposit credited as verified income.";
    await load();
  } catch (error) { notice.textContent = error.message; }
};
load();
setInterval(load, 3000);
</script>
</body>
</html>`;
}
