import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Constitution shipped beside the package (repo root in dev, /app in the image).
 * Resolved from this module's URL so an agent's writable workspace is never the source.
 */
export function imageConstitutionPath(): string {
  const url = new URL(import.meta.url);
  url.search = "";
  url.hash = "";
  return path.resolve(path.dirname(fileURLToPath(url)), "..", "constitution.md");
}

export function loadConstitutionText(): string {
  return fs.readFileSync(imageConstitutionPath(), "utf8");
}

export const CONSTITUTION_TEXT = loadConstitutionText();

export interface Review {
  allowed: boolean;
  law: "I" | "II" | "III" | "owner" | "ok";
  reason: string;
}

const ok: Review = { allowed: true, law: "ok", reason: "allowed" };

const BLOCKED_COMMAND = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)\s+\/(\s|$)/,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=/i,
  /\b(nmap|masscan|hydra|sqlmap|metasploit|msfconsole|aircrack-ng|hashcat)\b/i,
  /169\.254\.169\.254/,
  /metadata\.google\.internal/i,
  /docker\.sock/,
  /\b(sendmail|postfix|swaks|mailx)\b/i,
  /WALLET_MASTER_KEY|OPENROUTER_API_KEY|ADMIN_TOKEN/,
  /id_rsa|\.aws\/credentials|\/etc\/shadow|\.ssh\b/i,
  /\b(curl|wget)\b[^|\n]*\|\s*(sh|bash|zsh)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

const DECEPTION = [
  /\bi am (a )?human\b/i,
  /\bi am a real person\b/i,
  /\bi'?m not (an? )?(ai|bot|language model|automaton)\b/i,
  /\bi am not (an? )?(ai|bot|language model|automaton)\b/i,
  /\bas a human\b/i,
  /\bi am kevin\b/i,
  /\bthis is kevin\b/i,
];

const DEFAULT_DENY_HOSTS = [
  "mail.google.com",
  "accounts.google.com",
  "myaccount.google.com",
  "outlook.live.com",
  "outlook.office.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
];

const SHELL_CLIENT = /\b(?:curl|wget|fetch|lynx|w3m|links|elinks|nc|ncat|ssh|scp|sftp|ping|dig|nslookup)\b/i;

export function constitutionDenyHosts(source: string | undefined = process.env.CONSTITUTION_DENY_HOSTS): string[] {
  if (!source) return [];
  const hosts: string[] = [];
  for (const item of source.split(",")) {
    const host = normalizeHost(item);
    if (host) hosts.push(host);
  }
  return hosts;
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^\.+|\.+$/g, "");
}

/** The deny-list entry that matches host, or null when the host is not listed. */
export function deniedHostMatch(host: string, denyHosts: readonly string[]): string | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  for (const entry of denyHosts) {
    const denied = normalizeHost(entry);
    if (!denied) continue;
    if (normalized === denied || normalized.endsWith(`.${denied}`)) return denied;
  }
  return null;
}

function refuseDeniedHost(host: string, matched: string): Review {
  const normalized = normalizeHost(host);
  const reason = `Refused ${normalized}: matches CONSTITUTION_DENY_HOSTS entry ${matched}.`;
  console.error(JSON.stringify({ level: "warn", msg: "constitution deny", host: normalized, matched, reason }));
  return { allowed: false, law: "owner", reason };
}

function reviewDeniedHost(host: string): Review | null {
  const matched = deniedHostMatch(host, constitutionDenyHosts());
  if (!matched) return null;
  return refuseDeniedHost(host, matched);
}

function authorityHost(authority: string): string {
  let value = authority;
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(1, end) : value;
  }
  return value.replace(/:\d+$/, "");
}

/** http(s) URLs in a shell command, plus bare hosts passed to fetch, shell, or browse clients. */
function hostsTargetedByCommand(command: string): string[] {
  const hosts: string[] = [];
  const seen = new Set<string>();
  const add = (host: string) => {
    const cleaned = normalizeHost(host);
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    hosts.push(cleaned);
  };
  for (const match of command.matchAll(/\bhttps?:\/\/([^/\s"'<>]+)/gi)) {
    add(authorityHost(match[1] ?? ""));
  }
  if (SHELL_CLIENT.test(command)) {
    for (const token of command.split(/\s+/)) {
      if (!token || token.startsWith("-")) continue;
      const cleaned = token.replace(/^['"]|['"]$/g, "");
      if (/^https?:\/\//i.test(cleaned)) continue;
      const bare = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?(?:[/?#].*)?$/i.exec(cleaned);
      if (bare?.[1]) add(bare[1]);
    }
  }
  return hosts;
}

export function reviewCommand(command: string): Review {
  for (const host of hostsTargetedByCommand(command)) {
    const denied = reviewDeniedHost(host);
    if (denied) return denied;
  }
  for (const pattern of BLOCKED_COMMAND) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        law: "I",
        reason: "Command blocked by the constitution (harm, credentials, spam, or host secrets).",
      };
    }
  }
  if (DECEPTION.some((pattern) => pattern.test(command))) {
    return { allowed: false, law: "III", reason: "Command would deceive a person about who is speaking." };
  }
  return ok;
}

export function reviewText(text: string): Review {
  if (DECEPTION.some((pattern) => pattern.test(text))) {
    return {
      allowed: false,
      law: "III",
      reason: "Text claims to be human, denies being an AI, or impersonates the owner.",
    };
  }
  return ok;
}

export function isPrivateIp(ip: string): boolean {
  const mapped = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (mapped === "::1" || mapped === "::") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (!v4) {
    const lower = mapped.toLowerCase();
    return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
  }
  const parts = v4.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export async function reviewUrl(
  raw: string,
  denyHosts: string[],
  resolveHost: (host: string) => Promise<string[]>,
): Promise<Review> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, law: "I", reason: "URL is not valid." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, law: "I", reason: "Only http and https URLs are allowed." };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const constitutionDenied = reviewDeniedHost(host);
  if (constitutionDenied) return constitutionDenied;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return { allowed: false, law: "owner", reason: "Local and internal hosts are off limits." };
  }
  const denied = [...DEFAULT_DENY_HOSTS, ...denyHosts.map((item) => item.toLowerCase())];
  if (denied.some((item) => host === item || host.endsWith(`.${item}`))) {
    return { allowed: false, law: "owner", reason: "That host is on the owner's personal-account denylist." };
  }
  if (isPrivateIp(host)) {
    return { allowed: false, law: "I", reason: "Private and link-local addresses are off limits." };
  }
  try {
    const addresses = await resolveHost(host);
    if (addresses.length === 0 || addresses.some((address) => isPrivateIp(address))) {
      return { allowed: false, law: "I", reason: "URL resolves to a private or link-local address." };
    }
  } catch {
    return { allowed: false, law: "I", reason: "Could not resolve the host." };
  }
  return ok;
}
