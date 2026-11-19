import readline from "node:readline";
import { defaultResolve, reviewHop } from "./safety.ts";

const denyHosts = (() => {
  try {
    const parsed = JSON.parse(process.env.DENY_HOSTS ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
})();

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let url = "";
  try {
    const parsed = JSON.parse(trimmed) as { url?: string };
    url = typeof parsed.url === "string" ? parsed.url : "";
    const verdict = url ? await reviewHop(url, denyHosts, defaultResolve) : { allowed: false, reason: "URL is not valid." };
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "URL check failed.";
    process.stdout.write(`${JSON.stringify({ allowed: false, reason, url })}\n`);
  }
}
