import type { ResolveHost } from "./safety.ts";

export class SeeError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SeeError";
    this.status = status;
  }
}

export interface BrowseRequest {
  url: string;
  screenshot: boolean;
  denyHosts: readonly string[];
  resolveHost: ResolveHost;
  executablePath?: string;
  launchArgs?: string[];
}

export interface PageView {
  title: string;
  markdown: string;
  links: string[];
  png?: string;
}
