import { vi } from "vitest";

import type { RemoteAgentDownloadDeps } from "./remoteAgentDownload";

/** Shared fakes for the download worker tests: an in-memory edge cache and injected deps. */

export const PINNED_PREFIX = "https://github.com/youpele52/bigbud/releases/download/";
export const BETA_CACHE_KEY = "https://bigbud.app/__cache/remote-agent/beta";
export const BETA_LAST_GOOD_KEY = `${BETA_CACHE_KEY}/last-good`;

export function memoryCache(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    match: vi.fn(async (key: RequestInfo | URL) => {
      const value = entries.get(String(key));
      return value === undefined ? undefined : new Response(value);
    }),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      entries.set(String(key), await response.text());
    }),
  };
}

export function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

export function makeDeps(
  options: {
    cache?: ReturnType<typeof memoryCache>;
    fetch?: RemoteAgentDownloadDeps["fetch"];
    token?: string;
  } = {},
) {
  const pending: Promise<unknown>[] = [];
  const cache = options.cache ?? memoryCache();
  const fetch = vi.fn(
    options.fetch ??
      (async () =>
        apiResponse([
          { tag_name: "v0.4.0-beta.5", prerelease: true, assets: [{ name: "remote-agent.sh" }] },
        ])),
  );
  const deps: RemoteAgentDownloadDeps = {
    env: options.token === undefined ? {} : { GITHUB_TOKEN: options.token },
    fetch,
    cache,
    waitUntil: (promise) => pending.push(promise),
  };
  return { deps, cache, fetch, settle: () => Promise.all(pending) };
}

export function atomEntry(tag: string): string {
  return [
    "<entry>",
    `<id>tag:github.com,2008:Repository/1217105994/${tag}</id>`,
    `<link rel="alternate" type="text/html" href="https://github.com/youpele52/bigbud/releases/tag/${tag}"/>`,
    `<title>${tag}</title>`,
    "</entry>",
  ].join("\n");
}

export function atomFeed(entries: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    "<title>Release notes from bigbud</title>",
    ...entries,
    "</feed>",
  ].join("\n");
}
