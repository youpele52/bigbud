import { describe, expect, it } from "vitest";
import {
  filterBrowserHistory,
  resolveBrowserHistorySelectionIndex,
  resolveNextBrowserHistory,
} from "./BrowserPanel.history";

describe("BrowserPanel history", () => {
  it("records unique URLs most-recent-first and caps history at 10", () => {
    const initial = Array.from({ length: 10 }, (_, index) => `https://site-${index}.com`);

    const updated = resolveNextBrowserHistory(initial, "https://site-4.com");

    expect(updated).toHaveLength(10);
    expect(updated[0]).toBe("https://site-4.com");
    expect(updated.filter((url) => url === "https://site-4.com")).toHaveLength(1);
  });

  it("returns matching URL suggestions for typed query text", () => {
    const history = [
      "https://nairaland.com/",
      "https://example.com/",
      "https://news.ycombinator.com/",
    ];

    expect(filterBrowserHistory(history, "nai")).toEqual(["https://nairaland.com/"]);
  });

  it("returns stored URLs when the focused address bar is empty", () => {
    const history = Array.from({ length: 10 }, (_, index) => `https://site-${index}.com`);

    expect(filterBrowserHistory(history, "")).toEqual(history);
  });

  it("moves suggestion selection with wrapping arrow-key semantics", () => {
    expect(resolveBrowserHistorySelectionIndex(-1, 1, 3)).toBe(0);
    expect(resolveBrowserHistorySelectionIndex(-1, -1, 3)).toBe(2);
    expect(resolveBrowserHistorySelectionIndex(2, 1, 3)).toBe(0);
    expect(resolveBrowserHistorySelectionIndex(0, -1, 3)).toBe(2);
    expect(resolveBrowserHistorySelectionIndex(0, 1, 0)).toBe(-1);
  });
});
