import { capItems, decodeEntities, feedItem, toIso, trimText } from "./text.ts";
import type { FeedItem } from "./types.ts";

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

/**
 * A small RSS 2.0 / Atom reader. Feeds only need elements, attributes, text,
 * CDATA, and the five XML entities, so this stays in-tree instead of adding a
 * parser dependency.
 */
export function parseXml(source: string): XmlNode {
  const input = source
    .replace(/^\uFEFF/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    if (match.index === re.lastIndex) re.lastIndex += 1;
    if (match[0].startsWith("<!--")) continue;
    if (match[0].startsWith("<![CDATA[")) {
      stack[stack.length - 1].text += match[1] ?? "";
      continue;
    }
    if (match[3]) {
      const name = localName(match[3]);
      if (match[2] === "/") {
        while (stack.length > 1) {
          const popped = stack.pop();
          if (popped?.name === name) break;
        }
        continue;
      }
      const node: XmlNode = { name, attrs: parseAttrs(match[4] ?? ""), children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (match[5] !== "/") stack.push(node);
      continue;
    }
    if (match[6]) stack[stack.length - 1].text += match[6];
  }
  return root.children[0] ?? root;
}

function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw))) {
    attrs[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

function firstChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

function nodeText(node: XmlNode | undefined): string {
  if (!node) return "";
  const nested = node.children.map((child) => nodeText(child)).join(" ");
  return trimText(`${node.text} ${nested}`);
}

function collectEntries(node: XmlNode, found: XmlNode[]): void {
  if (node.name === "item" || node.name === "entry") {
    found.push(node);
    return;
  }
  for (const child of node.children) collectEntries(child, found);
}

function linkOf(node: XmlNode): string {
  const links = childrenNamed(node, "link");
  const alternate = links.find((link) => (link.attrs.rel ?? "alternate") === "alternate" && link.attrs.href);
  if (alternate?.attrs.href) return alternate.attrs.href.trim();
  const href = links.find((link) => link.attrs.href);
  if (href?.attrs.href) return href.attrs.href.trim();
  const text = nodeText(firstChild(node, "link"));
  if (/^https?:\/\//i.test(text)) return text;
  const guid = firstChild(node, "guid") ?? firstChild(node, "id");
  const id = nodeText(guid);
  if (/^https?:\/\//i.test(id)) return id;
  return "";
}

function authorOf(node: XmlNode): string {
  const authors = childrenNamed(node, "author")
    .map((author) => nodeText(firstChild(author, "name")) || nodeText(author))
    .filter(Boolean);
  if (authors.length) return authors.join(", ");
  return nodeText(firstChild(node, "creator"));
}

export function parseFeedXml(body: string, source: string): FeedItem[] {
  const root = parseXml(body);
  const entries: XmlNode[] = [];
  collectEntries(root, entries);
  const items: FeedItem[] = [];
  for (const entry of entries) {
    const url = linkOf(entry);
    const id = nodeText(firstChild(entry, "id")) || nodeText(firstChild(entry, "guid")) || url;
    const title = nodeText(firstChild(entry, "title")) || id || "untitled";
    const text =
      nodeText(firstChild(entry, "description")) ||
      nodeText(firstChild(entry, "summary")) ||
      nodeText(firstChild(entry, "content")) ||
      "";
    const created =
      nodeText(firstChild(entry, "published")) ||
      nodeText(firstChild(entry, "updated")) ||
      nodeText(firstChild(entry, "pubDate")) ||
      nodeText(firstChild(entry, "date"));
    if (!url) continue;
    items.push(
      feedItem({
        source,
        id: id || url,
        title,
        url,
        text,
        author: authorOf(entry) || undefined,
        created_at: toIso(created),
      }),
    );
  }
  return capItems(items);
}
