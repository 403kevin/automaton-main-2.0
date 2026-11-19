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

export class SensesRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SensesRequestError";
  }
}

export interface SensesClient {
  see(input: SeePageRequest): Promise<SeePageResult>;
}

const MAX_BODY_BYTES = 2_000_000;

export class HttpSensesClient implements SensesClient {
  constructor(private readonly baseUrl: string) {}

  async see(input: SeePageRequest): Promise<SeePageResult> {
    let response: Response;
    try {
      response = await fetch(new URL("/see", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: input.url,
          screenshot: input.screenshot,
          denyHosts: input.denyHosts,
        }),
        signal: AbortSignal.timeout(120_000),
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
    const links = Array.isArray(record.links) ? record.links.filter((item): item is string => typeof item === "string") : [];
    return {
      title: typeof record.title === "string" ? record.title : "",
      markdown: typeof record.markdown === "string" ? record.markdown : "",
      links,
      png: typeof record.png === "string" ? record.png : undefined,
    };
  }
}
