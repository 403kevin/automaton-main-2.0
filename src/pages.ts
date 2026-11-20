/** Public page and endpoint names. One path segment, no traversal. */
export const PUBLIC_SLUG = /^[a-z0-9-]{1,40}$/;

export const MAX_PAGES_PER_AGENT = 20;
export const MAX_PAGE_BYTES = 200 * 1024;

export function isPublicSlug(value: string): boolean {
  return PUBLIC_SLUG.test(value);
}

export function bannerText(agentId: string): string {
  return `This page was written and is run by an autonomous AI agent (${agentId}). No human reviewed it.`;
}

export type AgentRoute =
  | { kind: "legacy"; agentId: string }
  | { kind: "index"; agentId: string }
  | { kind: "name"; agentId: string; name: string }
  | { kind: "refuse" }
  | { kind: "no" };

const AGENT_ID = /^a[a-f0-9]+$/;

/**
 * `/a/<agentId>` is the legacy static offer.
 * `/a/<agentId>/` lists that agent's pages.
 * `/a/<agentId>/<slug>` is one page or one paid endpoint.
 * Anything else under `/a` is refused so it cannot reach `/api`, `/admin`, or another tree.
 */
export function classifyAgentRoute(pathname: string): AgentRoute {
  if (pathname !== "/a" && !pathname.startsWith("/a/")) return { kind: "no" };
  if (pathname.includes("\0") || pathname.includes("\\") || pathname.includes("..")) return { kind: "refuse" };
  if (/%2e|%2f|%5c/i.test(pathname)) return { kind: "refuse" };
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "refuse" };
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes("..")) return { kind: "refuse" };
  const match = /^\/a\/([^/]+)(\/([^/]*))?$/.exec(decoded);
  if (!match) return { kind: "refuse" };
  const agentId = match[1] ?? "";
  if (!AGENT_ID.test(agentId)) return { kind: "refuse" };
  if (match[2] === undefined) return { kind: "legacy", agentId };
  const name = match[3] ?? "";
  if (name === "") return { kind: "index", agentId };
  if (!isPublicSlug(name)) return { kind: "refuse" };
  return { kind: "name", agentId, name };
}

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      blocks.push(`<h${level}>${formatInline(heading[2] ?? "")}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote><p>${formatInline(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? "")) {
        items.push(`<li>${formatInline((lines[index] ?? "").replace(/^[-*]\s+/, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index] ?? "")) {
        items.push(`<li>${formatInline((lines[index] ?? "").replace(/^\d+\.\s+/, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !isBlockStart(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(`<p>${formatInline(paragraph.join(" "))}</p>`);
  }
  return blocks.join("\n");
}

export function renderAgentPage(input: { agentId: string; title: string; bodyHtml: string }): string {
  const banner = bannerText(input.agentId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<title>${escapeHtml(input.title)}</title>
<style>
#automaton-agent-banner{display:block!important;visibility:visible!important;opacity:1!important;position:static!important;height:auto!important;max-height:none!important;width:auto!important;overflow:visible!important;clip:auto!important;font-size:16px!important;line-height:1.4!important;color:#1a1a1a!important;background:#fff4d6!important;border:1px solid #e0b000!important;padding:12px 16px!important;margin:0!important;font-family:sans-serif!important;}
main{font-family:sans-serif;line-height:1.5;padding:16px;max-width:70ch;}
</style>
</head>
<body>
<p id="automaton-agent-banner" role="note">${escapeHtml(banner)}</p>
<main>
${input.bodyHtml}
</main>
</body>
</html>
`;
}

export function renderPublishedPage(agentId: string, slug: string, markdown: string): string {
  return renderAgentPage({
    agentId,
    title: slug,
    bodyHtml: renderMarkdown(markdown),
  });
}

export interface ListedEndpoint {
  name: string;
  price: string;
  /** The runtime's recording of the last test run. Shown escaped, labelled as the runtime's. */
  lastTestOutput: string;
}

export function renderPageIndex(agentId: string, slugs: string[], endpoints: ListedEndpoint[] = []): string {
  const items = slugs.filter((slug) => isPublicSlug(slug));
  const pages = items.length
    ? `<ul>${items.map((slug) => `<li><a href="/a/${agentId}/${slug}">${escapeHtml(slug)}</a></li>`).join("")}</ul>`
    : "<p>No pages yet.</p>";
  const listed = endpoints.filter((endpoint) => isPublicSlug(endpoint.name));
  const paid = listed.length
    ? `<h2>Paid endpoints</h2><ul>${listed
        .map(
          (endpoint) =>
            `<li><a href="/a/${agentId}/${endpoint.name}">${escapeHtml(endpoint.name)}</a> ${escapeHtml(endpoint.price)}` +
            `<p><strong>Last test output (runtime)</strong></p><pre>${escapeHtml(endpoint.lastTestOutput)}</pre></li>`,
        )
        .join("")}</ul>`
    : "";
  return renderAgentPage({ agentId, title: `Pages by ${agentId}`, bodyHtml: `${pages}${paid}` });
}

function isBlockStart(line: string): boolean {
  return line.startsWith("```") || /^(#{1,6})\s+/.test(line) || /^>\s?/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line);
}

function formatInline(raw: string): string {
  const withoutImages = raw.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => String(alt ?? ""));
  let html = "";
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g;
  let last = 0;
  for (const match of withoutImages.matchAll(pattern)) {
    const index = match.index ?? 0;
    html += emphasize(escapeHtml(withoutImages.slice(last, index)));
    if (match[3] !== undefined) {
      html += `<code>${escapeHtml(match[3])}</code>`;
    } else if (isSafeHttp(match[2] ?? "")) {
      html += `<a href="${escapeHtml(match[2] ?? "")}" rel="nofollow noopener noreferrer">${emphasize(escapeHtml(match[1] ?? ""))}</a>`;
    } else {
      html += emphasize(escapeHtml(match[0]));
    }
    last = index + match[0].length;
  }
  html += emphasize(escapeHtml(withoutImages.slice(last)));
  return html;
}

function emphasize(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function isSafeHttp(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false;
  if (/[\s"'<>\\]/.test(href)) return false;
  return true;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
