import { describe, expect, it } from "vitest";
import { normalizeBrowserFaviconUrl } from "./BrowserPanel.favicon";
import { getBrowserFaviconUrl, getBrowserSuggestions } from "./BrowserPanel.suggestions";
import { migrateBrowserHistory } from "./BrowserPanel.history";

const history = migrateBrowserHistory({
  version: 2,
  visits: [
    {
      normalizedUrl: "https://example.com/",
      origin: "https://example.com",
      title: "Example website",
      visitedAt: "2026-01-01T00:00:00.000Z",
      visitCount: 1,
      faviconUrl: "https://cdn.example.com/icon.png",
    },
  ],
});

describe("browser suggestions", () => {
  it("offers a search row and a deduplicated site row for URL input", () => {
    expect(getBrowserSuggestions(history, "example.com", "brave")).toEqual([
      {
        kind: "search",
        url: "https://search.brave.com/search?q=example.com",
        label: "example.com — Search Brave Search",
      },
      { kind: "url", url: "https://example.com/", label: "https://example.com/" },
    ]);
  });

  it("matches history by title without treating ordinary searches as websites", () => {
    const suggestions = getBrowserSuggestions(history, "website", "duckduckgo");
    expect(suggestions.map(({ kind }) => kind)).toEqual(["search", "url"]);
    expect(getBrowserSuggestions([], "coffee & tea", "google")).toEqual([
      {
        kind: "search",
        url: "https://www.google.com/search?q=coffee%20%26%20tea",
        label: "coffee & tea — Search Google",
      },
    ]);
    expect(getBrowserSuggestions(history, "", "google").map(({ kind }) => kind)).toEqual(["url"]);
  });

  it.each(["javascript:alert(1)", "file:///secret", "data:text/html,hello"])(
    "does not offer unsafe scheme %s",
    (input) => {
      expect(getBrowserSuggestions(history, input, "google")).toEqual([]);
    },
  );
});

describe("browser favicons", () => {
  it("reuses learned icons for the same origin, including another path", () => {
    expect(getBrowserFaviconUrl("https://example.com/", history)).toBe(
      "https://cdn.example.com/icon.png",
    );
    expect(getBrowserFaviconUrl("https://example.com/another?secret=1", history)).toBe(
      "https://cdn.example.com/icon.png",
    );
    expect(getBrowserFaviconUrl("https://other.example.com/", history)).toBe(
      "https://other.example.com/favicon.ico",
    );
    expect(getBrowserFaviconUrl("http://example.com/", history)).toBe(
      "http://example.com/favicon.ico",
    );
  });

  it("uses live metadata only for its observed origin, even without history", () => {
    const page = { url: "https://example.com/", faviconUrl: "https://cdn.example.com/live.png" };
    expect(getBrowserFaviconUrl("https://example.com/path", [], page)).toBe(page.faviconUrl);
    expect(getBrowserFaviconUrl("https://new.example.com/", [], page)).toBe(
      "https://new.example.com/favicon.ico",
    );
    expect(getBrowserFaviconUrl("https://example.com/", history, { ...page, url: null })).toBe(
      "https://cdn.example.com/icon.png",
    );
  });

  it.each(["not a URL", "https://", "https://user:secret@example.com/", "javascript:alert(1)"])(
    "never invents an icon endpoint for %s",
    (url) => {
      expect(getBrowserFaviconUrl(url, history)).toBeNull();
    },
  );

  it.each([
    ["https://unknown.com/path?secret=1#fragment", "https://unknown.com/favicon.ico"],
    ["http://localhost:3000/path?secret=1", "http://localhost:3000/favicon.ico"],
    ["http://192.168.0.1/path", "http://192.168.0.1/favicon.ico"],
    ["http://[::1]/path", "http://[::1]/favicon.ico"],
  ])("uses only the direct origin for %s without live metadata", (url, icon) => {
    expect(getBrowserFaviconUrl(url, [])).toBe(icon);
    expect(getBrowserFaviconUrl(url, [], undefined, false)).toBeNull();
  });

  it("keeps observed icons available while speculative fallback is disabled", () => {
    expect(getBrowserFaviconUrl("https://example.com/", history, undefined, false)).toBe(
      "https://cdn.example.com/icon.png",
    );
  });

  it.each([
    "javascript:alert(1)",
    "file:///secret",
    "data:image/svg+xml,<svg/>",
    "https://user:secret@example.com/icon",
    "bogus",
  ])("rejects unsafe learned icon %s", (url) => {
    expect(normalizeBrowserFaviconUrl(url)).toBeNull();
  });
});
