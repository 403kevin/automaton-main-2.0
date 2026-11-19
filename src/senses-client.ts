export interface SeePageRequest {
  url: string;
  screenshot: boolean;
  denyHosts: string[];
}

export interface SeePageResult {
  title: string;
  markdown: string;
  links: string[];
  png?: string;
}

export interface CrawlPage {
  url: string;
  title: string;
  markdown: string;
}

export interface CrawlSkip {
  url: string;
  reason: string;
}

export type RobotsStatus = "ok" | "missing" | "unreachable";

export interface CrawlSiteRequest {
  url: string;
  maxPages: number;
  sameDomain: boolean;
  denyHosts: string[];
}

export interface CrawlSiteResult {
  pages: CrawlPage[];
  skipped: CrawlSkip[];
  robots: RobotsStatus;
}

export class SensesRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SensesRequestError";
  }
}

export interface FeedItem {
  source: string;
  id: string;
  title: string;
  url: string;
  text: string;
  author?: string;
  score?: number;
  created_at?: string;
}

export interface FeedRequest {
  source: string;
  query: string;
  options: Record<string, unknown>;
  denyHosts: string[];
  userAgent?: string;
}

export interface FeedResult {
  source: string;
  items: FeedItem[];
  blocked: boolean;
  unavailable: boolean;
  status?: number;
  reason?: string;
}

export interface SensesClient {
  see(input: SeePageRequest): Promise<SeePageResult>;
  crawl(input: CrawlSiteRequest): Promise<CrawlSiteResult>;
  feed(input: FeedRequest): Promise<FeedResult>;
}

const MAX_BODY_BYTES = 2_000_000;

export class HttpSensesClient implements SensesClient {
  constructor(private readonly baseUrl: string) {}

  async see(input: SeePageRequest): Promise<SeePageResult> {
    const record = await this.post(
      "/see",
      { url: input.url, screenshot: input.screenshot, denyHosts: input.denyHosts },
      120_000,
    );
    const links = Array.isArray(record.links) ? record.links.filter((item): item is string => typeof item === "string") : [];
    return {
      title: typeof record.title === "string" ? record.title : "",
      markdown: typeof record.markdown === "string" ? record.markdown : "",
      links,
      png: typeof record.png === "string" ? record.png : undefined,
    };
  }

  async crawl(input: CrawlSiteRequest): Promise<CrawlSiteResult> {
    const record = await this.post(
      "/crawl",
      {
        url: input.url,
        max_pages: input.maxPages,
        same_domain: input.sameDomain,
        denyHosts: input.denyHosts,
      },
      150_000,
    );
    const pages = Array.isArray(record.pages)
      ? record.pages.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const page = item as Record<string, unknown>;
          return [
            {
              url: typeof page.url === "string" ? page.url : "",
              title: typeof page.title === "string" ? page.title : "",
              markdown: typeof page.markdown === "string" ? page.markdown : "",
            },
          ];
        })
      : [];
    const skipped = Array.isArray(record.skipped)
      ? record.skipped.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const skip = item as Record<string, unknown>;
          return [
            {
              url: typeof skip.url === "string" ? skip.url : "",
              reason: typeof skip.reason === "string" ? skip.reason : "",
            },
          ];
        })
      : [];
    const robots = record.robots === "ok" || record.robots === "missing" || record.robots === "unreachable" ? record.robots : "missing";
    return { pages, skipped, robots };
  }

  async feed(input: FeedRequest): Promise<FeedResult> {
    const record = await this.post(
      "/feed",
      {
        source: input.source,
        query: input.query,
        options: input.options,
        denyHosts: input.denyHosts,
        userAgent: input.userAgent,
      },
      20_000,
    );
    const items = Array.isArray(record.items)
      ? record.items.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const row = item as Record<string, unknown>;
          if (typeof row.id !== "string" || typeof row.url !== "string") return [];
          const feedItem: FeedItem = {
            source: typeof row.source === "string" ? row.source : input.source,
            id: row.id,
            title: typeof row.title === "string" ? row.title : "",
            url: row.url,
            text: typeof row.text === "string" ? row.text : "",
          };
          if (typeof row.author === "string" && row.author) feedItem.author = row.author;
          if (typeof row.score === "number" && Number.isFinite(row.score)) feedItem.score = row.score;
          if (typeof row.created_at === "string" && row.created_at) feedItem.created_at = row.created_at;
          return [feedItem];
        })
      : [];
    return {
      source: typeof record.source === "string" ? record.source : input.source,
      items,
      blocked: record.blocked === true,
      unavailable: record.unavailable === true,
      status: typeof record.status === "number" ? record.status : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
    };
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Senses is unreachable.";
      throw new SensesRequestError(message, 502);
    }
    const advertised = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > MAX_BODY_BYTES) {
      throw new SensesRequestError("Response body exceeds 2 MB.", 413);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) {
      throw new SensesRequestError("Response body exceeds 2 MB.", 413);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SensesRequestError("Senses returned invalid JSON.", 502);
    }
    const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    if (!response.ok) {
      const error = typeof record.error === "string" ? record.error : `Senses returned HTTP ${response.status}.`;
      throw new SensesRequestError(error, response.status);
    }
    return record;
  }
}
