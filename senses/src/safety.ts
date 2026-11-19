import { lookup } from "node:dns/promises";
import net from "node:net";

/** Decimal megabytes, matching the HTTP body cap on /see. */
export const MAX_BODY_BYTES = 2_000_000;
export const PAGE_TIMEOUT_MS = 20_000;

const MAX_REDIRECTS = 5;

export interface Review {
  allowed: boolean;
  reason: string;
}

export interface HopResponse {
  status: number;
  location: string | null;
  tooBig?: boolean;
}

export type ResolveHost = (host: string) => Promise<string[]>;
export type FetchHop = (url: string) => Promise<HopResponse>;

const blocked = new net.BlockList();
blocked.addSubnet("0.0.0.0", 8, "ipv4");
blocked.addSubnet("10.0.0.0", 8, "ipv4");
blocked.addSubnet("100.64.0.0", 10, "ipv4");
blocked.addSubnet("127.0.0.0", 8, "ipv4");
blocked.addSubnet("169.254.0.0", 16, "ipv4");
blocked.addSubnet("172.16.0.0", 12, "ipv4");
blocked.addSubnet("192.168.0.0", 16, "ipv4");
blocked.addAddress("::", "ipv6");
blocked.addAddress("::1", "ipv6");
blocked.addSubnet("fc00::", 7, "ipv6");
blocked.addSubnet("fe80::", 10, "ipv6");

const allow: Review = { allowed: true, reason: "allowed" };

export function refuse(reason: string): Review {
  return { allowed: false, reason };
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^\.+|\.+$/g, "");
}

/** Same host and subdomain rule as src/constitution.ts deniedHostMatch. */
export function localDeniedHostMatch(host: string, denyHosts: readonly string[]): string | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  for (const entry of denyHosts) {
    const denied = normalizeHost(entry);
    if (!denied) continue;
    if (normalized === denied || normalized.endsWith(`.${denied}`)) return denied;
  }
  return null;
}

type DenyMatch = (host: string, denyHosts: readonly string[]) => string | null;

let denyMatch: DenyMatch = localDeniedHostMatch;
let denySource: "constitution" | "local" = "local";
let loading: Promise<void> | undefined;

function loadDenyMatch(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        // The orchestrator module is present in this repo and, when the image
        // build copies it, in the senses container. It is not a package export,
        // so a missing file falls back to the same host rule locally.
        const mod = await import("../../src/constitution.ts");
        if (typeof mod.deniedHostMatch === "function") {
          denyMatch = mod.deniedHostMatch as DenyMatch;
          denySource = "constitution";
        }
      } catch {
        denySource = "local";
      }
    })();
  }
  return loading;
}

export async function constitutionDenySource(): Promise<"constitution" | "local"> {
  await loadDenyMatch();
  return denySource;
}

export function localIsBlockedAddress(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase().replace(/%.+$/, "");
  const mapped = ipv4FromMapped(trimmed);
  const candidate = mapped ?? trimmed;
  const family = net.isIP(candidate);
  if (family === 4) return blocked.check(candidate, "ipv4");
  if (family === 6) return blocked.check(candidate, "ipv6");
  return true;
}

function ipv4FromMapped(ip: string): string | null {
  if (!ip.startsWith("::ffff:")) return null;
  const rest = ip.slice(7);
  if (net.isIP(rest) === 4) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function dotted(value: number): string {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

/** IP literals, plus decimal and hex forms Chromium would treat as IPv4. */
export function canonicalIp(host: string): string | null {
  const value = normalizeHost(host).replace(/%.+$/, "");
  if (net.isIP(value)) return value;
  const hex = /^0x([0-9a-f]+)$/.exec(value);
  if (hex?.[1]) {
    const parsed = Number.parseInt(hex[1], 16);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) return dotted(parsed);
  }
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff) return dotted(parsed);
  }
  return null;
}

export async function defaultResolve(host: string): Promise<string[]> {
  const literal = canonicalIp(host);
  if (literal && net.isIP(literal)) return [literal];
  const looked = await lookup(host, { all: true, verbatim: true });
  return looked.map((entry) => entry.address);
}

export async function defaultFetchHop(url: string): Promise<HopResponse> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const length = Number(response.headers.get("content-length") ?? "0");
  await response.body?.cancel().catch(() => undefined);
  return {
    status: response.status,
    location: response.headers.get("location"),
    tooBig: Number.isFinite(length) && length > MAX_BODY_BYTES,
  };
}

export async function reviewHop(raw: string, denyHosts: readonly string[], resolveHost: ResolveHost): Promise<Review> {
  await loadDenyMatch();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("URL is not valid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse("Only http and https URLs are allowed.");
  }
  if (url.username || url.password) return refuse("URLs with credentials are off limits.");
  const host = normalizeHost(url.hostname);
  if (!host) return refuse("URL is missing a host.");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return refuse("Local and internal hosts are off limits.");
  }
  const matched = denyMatch(host, denyHosts);
  if (matched) return refuse(`Refused ${host}: matches deny list entry ${matched}.`);
  if (/^\d+(\.\d+){0,3}$/.test(host)) {
    const parts = host.split(".");
    const canonical =
      parts.length === 4 &&
      parts.every((part) => part === String(Number(part)) && Number(part) >= 0 && Number(part) <= 255);
    if (!canonical || localIsBlockedAddress(parts.join("."))) {
      return refuse("Private and link-local addresses are off limits.");
    }
    return allow;
  }
  const literal = canonicalIp(host);
  if (literal) {
    if (localIsBlockedAddress(literal)) return refuse("Private and link-local addresses are off limits.");
    return allow;
  }
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    return refuse("Could not resolve the host.");
  }
  if (addresses.length === 0 || addresses.some((address) => localIsBlockedAddress(address))) {
    return refuse("URL resolves to a private or link-local address.");
  }
  return allow;
}

export async function reviewSeeUrl(
  raw: string,
  denyHosts: readonly string[],
  resolveHost: ResolveHost,
  fetchHop: FetchHop = defaultFetchHop,
): Promise<Review> {
  let current = raw;
  const seen = new Set<string>();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (seen.has(current)) return refuse("Redirect loop.");
    seen.add(current);
    const verdict = await reviewHop(current, denyHosts, resolveHost);
    if (!verdict.allowed) return verdict;
    let response: HopResponse;
    try {
      response = await fetchHop(current);
    } catch {
      return allow;
    }
    if (response.tooBig) return refuse("Response body exceeds 2 MB.");
    if (response.status < 300 || response.status >= 400) return allow;
    if (!response.location) return refuse("Redirect is missing a location.");
    if (hop === MAX_REDIRECTS) return refuse("Too many redirects.");
    try {
      current = new URL(response.location, current).href;
    } catch {
      return refuse("Redirect location is not a valid URL.");
    }
  }
  return refuse("Too many redirects.");
}
