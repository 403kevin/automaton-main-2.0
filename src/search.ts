export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchHit[]>;
}

export class MockSearch implements SearchProvider {
  constructor(private readonly reason = "No search key is set. SearXNG, Brave, Tavily, or Exa would return live results.") {}

  async search(query: string): Promise<SearchHit[]> {
    return [
      {
        title: "Search is mocked",
        url: "https://automaton.local/search",
        snippet: `${this.reason} Query: "${query.slice(0, 120)}".`,
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

export class BraveSearch implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string): Promise<SearchHit[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    const response = await fetch(url, { headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey } });
    if (!response.ok) throw new Error(`Brave Search HTTP ${response.status}`);
    const body = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (body.web?.results ?? []).slice(0, 5).map((result) => ({
      title: result.title ?? query,
      url: result.url ?? "",
      snippet: result.description ?? "",
    }));
  }
}

export class TavilySearch implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string): Promise<SearchHit[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: 5 }),
    });
    if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
    const body = (await response.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? []).slice(0, 5).map((result) => ({
      title: result.title ?? query,
      url: result.url ?? "",
      snippet: result.content ?? "",
    }));
  }
}

export class ExaSearch implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string): Promise<SearchHit[]> {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({ query, numResults: 5 }),
    });
    if (!response.ok) throw new Error(`Exa HTTP ${response.status}`);
    const body = (await response.json()) as { results?: { title?: string; url?: string; text?: string }[] };
    return (body.results ?? []).slice(0, 5).map((result) => ({
      title: result.title ?? query,
      url: result.url ?? "",
      snippet: result.text ?? "",
    }));
  }
}

export interface SearchConfig {
  searchProvider: "auto" | "mock" | "duckduckgo" | "searxng" | "brave" | "tavily" | "exa";
  searxngUrl: string;
  braveSearchKey?: string;
  tavilyKey?: string;
  exaKey?: string;
}

export function createSearch(config: SearchConfig): SearchProvider {
  const chosen = config.searchProvider === "auto" ? autoProvider(config) : config.searchProvider;
  if (chosen === "duckduckgo") return new DuckDuckGoSearch();
  if (chosen === "searxng") {
    if (!config.searxngUrl) return new MockSearch("SEARCH_PROVIDER=searxng needs SEARXNG_URL. Falling back to mock.");
    return new SearxSearch(config.searxngUrl);
  }
  if (chosen === "brave") {
    if (!config.braveSearchKey) return new MockSearch("SEARCH_PROVIDER=brave needs BRAVE_SEARCH_API_KEY. Falling back to mock.");
    return new BraveSearch(config.braveSearchKey);
  }
  if (chosen === "tavily") {
    if (!config.tavilyKey) return new MockSearch("SEARCH_PROVIDER=tavily needs TAVILY_API_KEY. Falling back to mock.");
    return new TavilySearch(config.tavilyKey);
  }
  if (chosen === "exa") {
    if (!config.exaKey) return new MockSearch("SEARCH_PROVIDER=exa needs EXA_API_KEY. Falling back to mock.");
    return new ExaSearch(config.exaKey);
  }
  return new MockSearch();
}

function autoProvider(config: SearchConfig): SearchConfig["searchProvider"] {
  if (config.searxngUrl) return "searxng";
  if (config.braveSearchKey) return "brave";
  if (config.tavilyKey) return "tavily";
  if (config.exaKey) return "exa";
  return "mock";
}
