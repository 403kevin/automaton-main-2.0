import { reviewUrl } from "./constitution.js";
import type { HandlerRunResult } from "./handlers.js";

/**
 * Checks that an offer works before it is sold (specs/BO-2.2-no-phantom-products.md). The runtime only checks that an
 * offer works. It never judges what is sold.
 */

export const MAX_OUTSIDE_URLS_CHECKED = 5;
export const URL_CHECK_TIMEOUT_MS = 5_000;

/** Runs a handler once and says what happened. The real one wraps the Docker sandbox; tests inject a fake. */
export interface OfferVerifier {
  test(input: { snapshotHash: string; stdin: string }): Promise<HandlerRunResult>;
}

export class SandboxOfferVerifier implements OfferVerifier {
  constructor(private readonly sandbox: { run(input: { snapshotHash: string; stdin: string }): Promise<HandlerRunResult> }) {}

  test(input: { snapshotHash: string; stdin: string }): Promise<HandlerRunResult> {
    return this.sandbox.run(input);
  }
}

export type UrlCheck = { ok: true } | { ok: false; reason: string };

/** Asks whether an outside URL answers. The real one makes HTTP requests; tests inject a fake. */
export interface UrlChecker {
  check(url: string): Promise<UrlCheck>;
}

export async function dnsResolveHost(host: string): Promise<string[]> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return [host];
  const dns = await import("node:dns/promises");
  const looked = await dns.lookup(host, { all: true });
  return looked.map((entry) => entry.address);
}

export interface HttpUrlCheckerOptions {
  denyHosts: string[];
  resolveHost?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** HEAD, then GET if HEAD fails, 5 seconds each, redirects not followed. Private and denied addresses are refused first. */
export class HttpUrlChecker implements UrlChecker {
  constructor(private readonly options: HttpUrlCheckerOptions) {}

  async check(url: string): Promise<UrlCheck> {
    const resolveHost = this.options.resolveHost ?? dnsResolveHost;
    const review = await reviewUrl(url, this.options.denyHosts, resolveHost);
    if (!review.allowed) return { ok: false, reason: review.reason };
    const send = this.options.fetchImpl ?? fetch;
    const timeoutMs = this.options.timeoutMs ?? URL_CHECK_TIMEOUT_MS;
    let failure = "no answer";
    for (const method of ["HEAD", "GET"] as const) {
      try {
        const response = await send(url, { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        void response.body?.cancel().catch(() => undefined);
        if (response.status < 400) return { ok: true };
        failure = `HTTP ${response.status}`;
      } catch (error) {
        failure = error instanceof Error ? error.message : "request failed";
      }
    }
    return { ok: false, reason: failure };
  }
}

const OUTSIDE_URL = /https?:\/\/[^\s<>"'`)\]]+/gi;

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

function isOwnAgentPath(url: string, agentId: string): boolean {
  try {
    return new URL(url).pathname.startsWith(`/a/${agentId}`);
  } catch {
    return false;
  }
}

/** The names the text links to under the agent's own /a/<id>/, whether the link is relative or absolute. */
export function ownLinkNames(text: string, agentId: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(`/a/${agentId.replace(/[^a-z0-9]/gi, "")}/([a-z0-9-]{1,40})`, "g");
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** http(s) URLs in the text that are not the agent's own /a/ paths, each once, in order of appearance. */
export function outsideUrls(text: string, agentId: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(OUTSIDE_URL)) {
    const url = trimUrl(match[0]);
    if (isOwnAgentPath(url, agentId)) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

export type LinkCheck =
  | { ok: true }
  | { ok: false; reason: string; code: "own_missing" | "dead" | "unconfigured" };

/**
 * Refuse text that advertises something that is not there: a link to the agent's own /a/<id>/<name> with no endpoint or
 * page of that name, or a dead outside URL. Own links are checked first (no network). Only the first five outside URLs
 * are checked, a cost bound. With no checker, any outside URL refuses the text (the check fails closed).
 */
export async function checkOfferLinks(input: {
  text: string;
  agentId: string;
  nameExists: (name: string) => boolean;
  checker: UrlChecker | undefined;
}): Promise<LinkCheck> {
  for (const name of ownLinkNames(input.text, input.agentId)) {
    if (!input.nameExists(name)) {
      return {
        ok: false,
        code: "own_missing",
        reason: `The link /a/${input.agentId}/${name} points at nothing: no endpoint or page has that name.`,
      };
    }
  }
  const urls = outsideUrls(input.text, input.agentId);
  if (urls.length === 0) return { ok: true };
  if (!input.checker) {
    return { ok: false, code: "unconfigured", reason: "URL checks are not configured, so text with outside URLs is refused." };
  }
  for (const url of urls.slice(0, MAX_OUTSIDE_URLS_CHECKED)) {
    const outcome = await input.checker.check(url);
    if (!outcome.ok) return { ok: false, code: "dead", reason: `The URL ${url} is not reachable: ${outcome.reason}.` };
  }
  return { ok: true };
}
