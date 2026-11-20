import { describe, expect, it } from "vitest";

import { handleRemoteAgentDownload } from "./remoteAgentDownload";
import { MAX_FEED_BYTES } from "./remoteAgentFeed";
import {
  BETA_CACHE_KEY,
  BETA_LAST_GOOD_KEY,
  PINNED_PREFIX,
  apiResponse,
  atomEntry,
  atomFeed,
  makeDeps,
  memoryCache,
} from "./remoteAgentTesting";

const FEED_URL = "https://github.com/youpele52/bigbud/releases.atom";
const ASSET_HOST = "https://release-assets.githubusercontent.com/github-production-release-asset/1";

function rateLimited(): Response {
  return new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  });
}

/** Fake GitHub: the API, the Atom feed, and release downloads keyed by tag (missing is 404). */
function github(options: {
  api?: () => Response;
  feed?: () => Response;
  assets?: Record<string, number>;
  present?: readonly string[];
}) {
  return async (input: string): Promise<Response> => {
    if (input.startsWith("https://api.github.com/")) return (options.api ?? rateLimited)();
    if (input === FEED_URL) return options.feed?.() ?? new Response("", { status: 502 });
    if (!input.startsWith(PINNED_PREFIX)) throw new Error(`Unexpected fetch ${input}`);
    const tag = input.slice(PINNED_PREFIX.length).split("/")[0] ?? "";
    const status = options.assets?.[tag] ?? (options.present?.includes(tag) ? 302 : 404);
    return new Response(null, {
      status,
      headers: status === 302 ? { Location: `${ASSET_HOST}?tag=${tag}` } : {},
    });
  };
}

function feedOf(tags: readonly string[]) {
  return () => new Response(atomFeed(tags.map(atomEntry)), { status: 200 });
}

function urls(fetch: ReturnType<typeof makeDeps>["fetch"]): string[] {
  return fetch.mock.calls.map(([url]) => url);
}

describe("remote agent channel links without a GitHub token", () => {
  it("uses the feed when the API is rate limited and skips a tag without the script", async () => {
    const { deps, cache, fetch, settle } = makeDeps({
      fetch: github({
        feed: feedOf(["v0.4.0-beta.6", "v0.4.0-beta.5", "v0.3.3"]),
        present: ["v0.4.0-beta.5"],
      }),
    });
    const response = await handleRemoteAgentDownload("beta", deps);
    await settle();
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.5/remote-agent.sh`);
    expect(cache.entries.get(BETA_CACHE_KEY)).toBe("v0.4.0-beta.5");
    expect(cache.entries.get(BETA_LAST_GOOD_KEY)).toBe("v0.4.0-beta.5");
    expect(urls(fetch).slice(1)).toEqual([
      FEED_URL,
      `${PINNED_PREFIX}v0.4.0-beta.6/remote-agent.sh`,
      `${PINNED_PREFIX}v0.4.0-beta.5/remote-agent.sh`,
    ]);
    const probe = fetch.mock.calls[2]?.[1];
    expect(probe?.method).toBe("HEAD");
    expect(probe?.redirect).toBe("manual");
  });

  it("falls back to the feed when the API times out", async () => {
    const { deps } = makeDeps({
      fetch: async (input) => {
        if (input.startsWith("https://api.github.com/")) throw new Error("timeout");
        return github({ feed: feedOf(["v0.4.0-beta.5"]), present: ["v0.4.0-beta.5"] })(input);
      },
    });
    const response = await handleRemoteAgentDownload("beta", deps);
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.5/remote-agent.sh`);
  });

  it("picks the newest tag of each channel from a mixed feed", async () => {
    const tags = [
      "v0.4.0-beta.9",
      "v0.5.0-preview.1",
      "v0.4.0-nightly.20261120",
      "v0.4.0-beta.10",
      "v0.3.3",
      "v0.4.0-beta.2",
      "v0.3.10",
    ];
    const expected = {
      beta: "v0.4.0-beta.10",
      preview: "v0.5.0-preview.1",
      nightly: "v0.4.0-nightly.20261120",
      latest: "v0.3.10",
      stable: "v0.3.10",
    };
    for (const [ref, tag] of Object.entries(expected)) {
      const { deps } = makeDeps({ fetch: github({ feed: feedOf(tags), present: tags }) });
      const response = await handleRemoteAgentDownload(ref, deps);
      expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}${tag}/remote-agent.sh`);
    }
  });

  it("does not ask the feed when the API answers", async () => {
    const { deps, fetch } = makeDeps();
    await handleRemoteAgentDownload("beta", deps);
    expect(urls(fetch).every((url) => url.startsWith("https://api.github.com/"))).toBe(true);
  });

  it.each([
    ["a malformed feed", () => new Response("<html>Whoa there!</html>", { status: 200 })],
    ["an oversized feed", () => new Response(atomFeed(["x".repeat(MAX_FEED_BYTES)]))],
    ["a feed error", () => new Response("", { status: 429 })],
    ["a feed without a beta", feedOf(["v0.3.3", "v0.4.0-preview.1"])],
  ])("returns an uncached 503 for %s when nothing is cached", async (_label, feed) => {
    const { deps, cache, settle } = makeDeps({ fetch: github({ feed, present: ["v0.3.3"] }) });
    const response = await handleRemoteAgentDownload("beta", deps);
    await settle();
    expect(response.status).toBe(503);
    expect(cache.entries.size).toBe(0);
  });

  it("checks at most three tags of the channel for the script", async () => {
    const tags = ["v0.4.0-beta.5", "v0.4.0-beta.4", "v0.4.0-beta.3", "v0.4.0-beta.2"];
    const { deps, fetch } = makeDeps({
      fetch: github({ feed: feedOf(tags), present: ["v0.4.0-beta.2"] }),
    });
    const response = await handleRemoteAgentDownload("beta", deps);
    expect(response.status).toBe(503);
    expect(urls(fetch).filter((url) => url.startsWith(PINNED_PREFIX))).toHaveLength(3);
  });

  it("stops at an inconclusive asset check and keeps the last good release", async () => {
    const cache = memoryCache({ [BETA_LAST_GOOD_KEY]: "v0.4.0-beta.5" });
    const { deps, settle } = makeDeps({
      cache,
      fetch: github({
        feed: feedOf(["v0.4.0-beta.6", "v0.4.0-beta.4"]),
        assets: { "v0.4.0-beta.6": 500 },
        present: ["v0.4.0-beta.4"],
      }),
    });
    const response = await handleRemoteAgentDownload("beta", deps);
    await settle();
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.5/remote-agent.sh`);
    expect([...cache.entries]).toEqual([[BETA_LAST_GOOD_KEY, "v0.4.0-beta.5"]]);
  });

  it("never treats a redirect off GitHub's asset host as the script", async () => {
    const { deps } = makeDeps({
      fetch: async (input) =>
        input.startsWith(PINNED_PREFIX)
          ? new Response(null, { status: 302, headers: { Location: "https://github.com/login" } })
          : github({ feed: feedOf(["v0.4.0-beta.5"]) })(input),
    });
    expect((await handleRemoteAgentDownload("beta", deps)).status).toBe(503);
  });

  it("never overwrites the last good release when both sources fail", async () => {
    const cache = memoryCache({ [BETA_LAST_GOOD_KEY]: "v0.4.0-beta.3" });
    const { deps, settle } = makeDeps({
      cache,
      fetch: github({ api: () => apiResponse({}, 502) }),
    });
    const response = await handleRemoteAgentDownload("beta", deps);
    await settle();
    expect(response.headers.get("Location")).toBe(`${PINNED_PREFIX}v0.4.0-beta.3/remote-agent.sh`);
    expect([...cache.entries]).toEqual([[BETA_LAST_GOOD_KEY, "v0.4.0-beta.3"]]);
  });
});
