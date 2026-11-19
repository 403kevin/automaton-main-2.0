import { type BrowseRequest, type PageView, SeeError } from "./contract.ts";
import { htmlToMarkdown } from "./markdown.ts";
import { MAX_BODY_BYTES, PAGE_TIMEOUT_MS, reviewHop } from "./safety.ts";

interface Extracted {
  title: string;
  html: string;
  links: string[];
}

export async function browse(input: BrowseRequest): Promise<PageView> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    executablePath: input.executablePath,
    args: ["--disable-dev-shm-usage", ...(input.launchArgs ?? [])],
    timeout: PAGE_TIMEOUT_MS,
  });
  let blocked: string | null = null;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      await page.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        const documentRequest = route.request().resourceType() === "document";
        try {
          if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:") || requestUrl.startsWith("about:")) {
            await route.continue();
            return;
          }
          const verdict = await reviewHop(requestUrl, input.denyHosts, input.resolveHost);
          if (!verdict.allowed) {
            if (documentRequest) blocked = verdict.reason;
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        } catch (error) {
          if (documentRequest) blocked = error instanceof Error ? error.message : "Request blocked.";
          await route.abort("blockedbyclient").catch(() => undefined);
        }
      });
      page.on("response", (response) => {
        const length = Number(response.headers()["content-length"] || 0);
        if (length > MAX_BODY_BYTES && response.request().resourceType() === "document") {
          blocked = "Response body exceeds 2 MB.";
        }
      });
      try {
        await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      } catch (error) {
        if (blocked) throw new SeeError(blocked, 400);
        const message = error instanceof Error ? error.message : "Page load failed.";
        if (/timeout/i.test(message)) throw new SeeError("Page load exceeded 20 s.", 504);
        throw new SeeError(message, 502);
      }
      if (blocked) throw new SeeError(blocked, 400);
      const extracted = await page.evaluate(() => {
        const root = document.querySelector("main, article, [role='main']") || document.body;
        const clone = root.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script, style, noscript, svg, iframe").forEach((node) => node.remove());
        const links = Array.from(root.querySelectorAll("a[href]"))
          .map((node) => (node as HTMLAnchorElement).href)
          .filter((href) => href.startsWith("http://") || href.startsWith("https://"));
        return { title: document.title || "", html: clone.innerHTML || "", links };
      });
      const view = await toView(extracted);
      if (Buffer.byteLength(view.markdown) > MAX_BODY_BYTES) {
        throw new SeeError("Response body exceeds 2 MB.", 413);
      }
      if (input.screenshot) {
        const bytes = await page.screenshot({ type: "png" });
        const png = Buffer.from(bytes);
        if (png.length > MAX_BODY_BYTES) throw new SeeError("Response body exceeds 2 MB.", 413);
        view.png = png.toString("base64");
      }
      return view;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function toView(extracted: Extracted): Promise<PageView> {
  if (Buffer.byteLength(extracted.html) > MAX_BODY_BYTES) {
    throw new SeeError("Response body exceeds 2 MB.", 413);
  }
  const links = [...new Set(extracted.links)].slice(0, 100);
  return {
    title: extracted.title.trim().slice(0, 300),
    markdown: htmlToMarkdown(extracted.html).slice(0, MAX_BODY_BYTES),
    links,
  };
}
