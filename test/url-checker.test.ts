import { describe, expect, it } from "vitest";
import { HttpUrlChecker } from "../src/verify-offer.js";

const PUBLIC = async () => ["93.184.216.34"];

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(plan: Array<number | Error>) {
  const calls: Call[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init });
    const next = plan.shift();
    if (next instanceof Error) throw next;
    return new Response(null, { status: next ?? 200 });
  };
  return { calls, impl: impl as typeof fetch };
}

function checker(plan: Array<number | Error>, resolve: (host: string) => Promise<string[]> = PUBLIC) {
  const fake = fakeFetch(plan);
  return { fake, checker: new HttpUrlChecker({ denyHosts: [], resolveHost: resolve, fetchImpl: fake.impl, timeoutMs: 5_000 }) };
}

describe("HttpUrlChecker", () => {
  it("accepts a URL that answers HEAD with a success status", async () => {
    const { fake, checker: c } = checker([200]);
    expect(await c.check("https://ok.example/p")).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.init?.method).toBe("HEAD");
  });

  it("falls back to GET when HEAD answers 400 or above, and accepts a good GET", async () => {
    const { fake, checker: c } = checker([405, 200]);
    expect(await c.check("https://ok.example/p")).toEqual({ ok: true });
    expect(fake.calls.map((call) => call.init?.method)).toEqual(["HEAD", "GET"]);
  });

  it("refuses a URL that is 404 for both HEAD and GET, naming the status", async () => {
    const { checker: c } = checker([404, 404]);
    const outcome = await c.check("https://dead.example/x");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("404");
  });

  it("refuses on a network error, naming the error", async () => {
    const { checker: c } = checker([new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED")]);
    const outcome = await c.check("https://down.example/y");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("ECONNREFUSED");
  });

  it("does not follow redirects, counts a redirect status as reachable, and sets a timeout", async () => {
    const { fake, checker: c } = checker([301]);
    expect(await c.check("https://moved.example/p")).toEqual({ ok: true });
    expect(fake.calls[0]?.init?.redirect).toBe("manual");
    expect(fake.calls[0]?.init?.signal).toBeTruthy();
  });

  it("refuses a private address without making a request", async () => {
    const { fake, checker: c } = checker([200], async () => ["10.0.0.5"]);
    const outcome = await c.check("http://internal.example/admin");
    expect(outcome.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});
