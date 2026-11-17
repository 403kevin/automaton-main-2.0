export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchHit[]>;
}

export class MockSearch implements SearchProvider {
  async search(query: string): Promise<SearchHit[]> {
    return [
      {
        title: "No search provider configured",
        url: "https://automaton.local/search",
        snippet: `Mock search has no live web results for "${query.slice(0, 120)}". Set SEARCH_PROVIDER to duckduckgo or searxng.`,
      },
    ];
  }
}

export class DuckDuckGoSearch implements SearchProvider {
  async search(query: string): Promise<SearchHit[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
    const body = (await response.json()) as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: { Text?: string; FirstURL?: string }[];
    };
    const hits: SearchHit[] = [];
    if (body.AbstractText) {
      hits.push({
        title: body.Heading || query,
        url: body.AbstractURL || url,
        snippet: body.AbstractText,
      });
    }
    for (const topic of body.RelatedTopics ?? []) {
      if (topic.Text && topic.FirstURL) {
        hits.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
      }
      if (hits.length >= 5) break;
    }
    return hits;
  }
}

export class SearxSearch implements SearchProvider {
  constructor(private readonly baseUrl: string) {}

  async search(query: string): Promise<SearchHit[]> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`SearxNG HTTP ${response.status}`);
    const body = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? []).slice(0, 5).map((result) => ({
      title: result.title ?? query,
      url: result.url ?? "",
      snippet: result.content ?? "",
    }));
  }
}

export function createSearch(provider: "mock" | "duckduckgo" | "searxng", searxngUrl: string): SearchProvider {
  if (provider === "duckduckgo") return new DuckDuckGoSearch();
  if (provider === "searxng") {
    if (!searxngUrl) throw new Error("SEARCH_PROVIDER=searxng requires SEARXNG_URL.");
    return new SearxSearch(searxngUrl);
  }
  return new MockSearch();
}
