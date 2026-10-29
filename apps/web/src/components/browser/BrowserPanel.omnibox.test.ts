import { describe, expect, it } from "vitest";

import { buildBrowserSearchUrl, resolveBrowserOmniboxInput } from "./BrowserPanel.omnibox";

describe("resolveBrowserOmniboxInput", () => {
  it.each([
    ["https://example.com/docs?source=browser", "https://example.com/docs?source=browser"],
    ["http://localhost:3000", "http://localhost:3000/"],
    ["example.com", "https://example.com/"],
    ["example.com:8443/docs", "https://example.com:8443/docs"],
    ["example.com:443", "https://example.com/"],
    ["localhost", "https://localhost/"],
    ["localhost:5173", "https://localhost:5173/"],
    ["localhost:443", "https://localhost/"],
    ["127.0.0.1", "https://127.0.0.1/"],
    ["127.0.0.1:5173", "https://127.0.0.1:5173/"],
    ["127.0.0.1:443", "https://127.0.0.1/"],
    ["[::1]:5173", "https://[::1]:5173/"],
    ["[::1]:443", "https://[::1]/"],
  ])("navigates URL-like input %s", (input, expected) => {
    expect(resolveBrowserOmniboxInput(input)).toBe(expected);
  });

  it.each([
    "best coffee near me",
    "react useEffect cleanup",
    "example",
    "site:example.com cats",
    "from:alice",
    "hello: world",
  ])("searches query input %s", (input) => {
    expect(resolveBrowserOmniboxInput(input)).toBe(buildBrowserSearchUrl(input));
  });

  it.each([
    "about:blank",
    "blob:https://example.com/id",
    "data:text/html,hello",
    "file:///etc/passwd",
    "ftp://example.com",
    "javascript:alert(1)",
    "mailto:user@example.com",
    "tel:+15555555555",
    "vbscript:msgbox(1)",
  ])("rejects unsupported scheme %s", (input) => {
    expect(resolveBrowserOmniboxInput(input)).toBeNull();
  });

  it("encodes Unicode and ampersands in search queries", () => {
    expect(resolveBrowserOmniboxInput("café & tea")).toBe(
      "https://duckduckgo.com/?q=caf%C3%A9%20%26%20tea",
    );
  });
});

describe("search engine selection", () => {
  it.each([
    ["duckduckgo", "https://duckduckgo.com/?q="],
    ["google", "https://www.google.com/search?q="],
    ["brave", "https://search.brave.com/search?q="],
    ["bing", "https://www.bing.com/search?q="],
    ["startpage", "https://www.startpage.com/sp/search?query="],
  ] as const)("uses %s for encoded queries while preserving navigation", (engine, prefix) => {
    expect(resolveBrowserOmniboxInput("café & tea", engine)).toBe(`${prefix}caf%C3%A9%20%26%20tea`);
    expect(resolveBrowserOmniboxInput("example.com", engine)).toBe("https://example.com/");
    expect(resolveBrowserOmniboxInput("javascript:alert(1)", engine)).toBeNull();
  });
});
