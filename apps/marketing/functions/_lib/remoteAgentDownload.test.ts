import { describe, expect, it, vi } from "vitest";

import { handleRemoteAgentDownload, type RemoteAgentDownloadDeps } from "./remoteAgentDownload";

const PINNED_PREFIX = "https://github.com/youpele52/bigbud/releases/download/";

function memoryCache(initial: Record<string, string> = {}) {
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

function apiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeDeps(
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

describe("handleRemoteAgentDownload", () => {
  it("redirects explicit tags without calling the API", async () => {
    const { deps, fetch } = makeDeps();
    const response = await handleRemoteAgentDownload("0.4.0-beta.6", deps);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.6/remote-agent.sh`);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a plain-text 404 for an unknown ref", async () => {
    const { deps } = makeDeps();
    const response = await handleRemoteAgentDownload("../etc", deps);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("resolves a channel, caches it fresh and as last good", async () => {
    const { deps, cache, settle } = makeDeps();
    const response = await handleRemoteAgentDownload("beta", deps);
    await settle();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.5/remote-agent.sh`);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(cache.entries.get("https://bigbud.app/__cache/remote-agent/beta")).toBe("v0.4.0-beta.5");
    expect(cache.entries.get("https://bigbud.app/__cache/remote-agent/beta/last-good")).toBe(
      "v0.4.0-beta.5",
    );
  });

  it("serves the fresh cache entry without calling the API", async () => {
    const cache = memoryCache({ "https://bigbud.app/__cache/remote-agent/beta": "v0.4.0-beta.4" });
    const { deps, fetch } = makeDeps({ cache });
    const response = await handleRemoteAgentDownload("beta", deps);
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.4/remote-agent.sh`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("explains that no stable release ships the script and points to beta", async () => {
    const { deps } = makeDeps({
      fetch: async () => apiResponse([{ tag_name: "v0.3.3", prerelease: false, assets: [] }]),
    });
    const response = await handleRemoteAgentDownload("latest", deps);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("No stable bigbud release");
    expect(body).toContain("https://bigbud.app/download/beta/remote-agent");
  });

  it("returns a plain-text 404 for a channel without releases", async () => {
    const { deps } = makeDeps();
    const response = await handleRemoteAgentDownload("nightly", deps);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("No bigbud nightly release");
  });

  it("serves the last good entry when the API fails", async () => {
    const cache = memoryCache({
      "https://bigbud.app/__cache/remote-agent/beta/last-good": "v0.4.0-beta.3",
    });
    const { deps } = makeDeps({ cache, fetch: async () => apiResponse({}, 502) });
    const response = await handleRemoteAgentDownload("beta", deps);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.3/remote-agent.sh`);
  });

  it("never redirects to a tampered cache entry", async () => {
    const cache = memoryCache({ "https://bigbud.app/__cache/remote-agent/beta": "https://evil" });
    const { deps } = makeDeps({ cache });
    const response = await handleRemoteAgentDownload("beta", deps);
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("returns 503 when the API fails and nothing was cached", async () => {
    const { deps } = makeDeps({
      fetch: async () => {
        throw new Error("timeout");
      },
    });
    const response = await handleRemoteAgentDownload("beta", deps);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sends the token only when it is configured", async () => {
    const withToken = makeDeps({ token: "github_pat_example" });
    await handleRemoteAgentDownload("beta", withToken.deps);
    const withHeaders = withToken.fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(withHeaders.Authorization).toBe("Bearer github_pat_example");
    expect(withHeaders["User-Agent"]).toBe("bigbud-download");
    expect(withHeaders.Accept).toBe("application/vnd.github+json");

    const withoutToken = makeDeps();
    await handleRemoteAgentDownload("beta", withoutToken.deps);
    const plainHeaders = withoutToken.fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(plainHeaders.Authorization).toBeUndefined();
  });

  it("pages past a full first page to find a quiet channel", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `v0.4.0-beta.${index + 1}`,
      prerelease: true,
      assets: [{ name: "remote-agent.sh" }],
    }));
    const { deps, fetch } = makeDeps({
      fetch: async (input) =>
        apiResponse(
          input.endsWith("page=1")
            ? filler
            : [
                {
                  tag_name: "v0.3.9-preview.2",
                  prerelease: true,
                  assets: [{ name: "remote-agent.sh" }],
                },
              ],
        ),
    });
    const response = await handleRemoteAgentDownload("preview", deps);
    expect(response.headers.get("Location")).toBe(
      `${PINNED_PREFIX}v0.3.9-preview.2/remote-agent.sh`,
    );
    expect(fetch.mock.calls.map(([url]) => url.split("?")[1])).toEqual([
      "per_page=100&page=1",
      "per_page=100&page=2",
    ]);
  });

  it("never replaces the last good release with a missing one", async () => {
    const cache = memoryCache({
      "https://bigbud.app/__cache/remote-agent/beta/last-good": "v0.4.0-beta.3",
    });
    const { deps, settle } = makeDeps({ cache, fetch: async () => apiResponse([]) });
    const response = await handleRemoteAgentDownload("beta", deps);
    await settle();
    expect(response.status).toBe(404);
    expect(cache.entries.get("https://bigbud.app/__cache/remote-agent/beta/last-good")).toBe(
      "v0.4.0-beta.3",
    );
  });
});
