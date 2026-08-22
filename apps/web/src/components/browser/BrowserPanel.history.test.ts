import { beforeEach, describe, expect, it, vi } from "vitest";

const browserStorageMock = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => values.get(key) ?? null),
    reset: () => values.clear(),
    set: vi.fn((key: string, value: unknown) => values.set(key, value)),
  };
});

vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: browserStorageMock.get,
  setLocalStorageItem: browserStorageMock.set,
}));

import {
  filterBrowserHistory,
  migrateBrowserHistory,
  resolveBrowserHistorySelectionIndex,
  resolveNextBrowserHistory,
  getBrowserBookmarks,
  getBrowserHistory,
  recordBrowserHistoryVisit,
  subscribeBrowserData,
  toggleBrowserBookmark,
} from "./BrowserPanel.history";

describe("BrowserPanel history", () => {
  beforeEach(() => {
    browserStorageMock.reset();
    browserStorageMock.get.mockClear();
    browserStorageMock.set.mockClear();
  });
  it("migrates legacy URL strings into versioned visit records", () => {
    expect(
      migrateBrowserHistory(
        ["https://user:password@example.com/path#section", "javascript:alert(1)"],
        "2026-01-01T00:00:00.000Z",
      ),
    ).toEqual([
      {
        normalizedUrl: "https://example.com/path",
        origin: "https://example.com",
        title: "",
        visitedAt: "2026-01-01T00:00:00.000Z",
        visitCount: 1,
      },
    ]);
  });

  it("updates visit counts most-recent-first and retains 20 records", () => {
    const initial = Array.from({ length: 20 }, (_, index) => ({
      normalizedUrl: `https://site-${index}.com/`,
      origin: `https://site-${index}.com`,
      title: `Site ${index}`,
      visitedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      visitCount: 1,
    }));

    const updated = resolveNextBrowserHistory(initial, {
      url: "https://site-4.com/#fragment",
      title: "Updated site",
      visitedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(updated).toHaveLength(20);
    expect(updated[0]).toMatchObject({
      normalizedUrl: "https://site-4.com/",
      title: "Updated site",
      visitCount: 2,
    });
  });

  it("returns matching URL suggestions for typed query text", () => {
    const history = migrateBrowserHistory(
      {
        version: 2,
        visits: [
          {
            normalizedUrl: "https://nairaland.com/",
            origin: "https://nairaland.com",
            title: "Nairaland Forum",
            visitedAt: "2026-01-03T00:00:00.000Z",
            visitCount: 1,
          },
          {
            normalizedUrl: "https://example.com/",
            origin: "https://example.com",
            title: "Example",
            visitedAt: "2026-01-02T00:00:00.000Z",
            visitCount: 1,
          },
        ],
      },
      "2026-01-01T00:00:00.000Z",
    );

    expect(filterBrowserHistory(history, "forum")).toEqual(["https://nairaland.com/"]);
    expect(filterBrowserHistory(history, "")).toEqual([
      "https://nairaland.com/",
      "https://example.com/",
    ]);
  });

  it("moves suggestion selection with wrapping arrow-key semantics", () => {
    expect(resolveBrowserHistorySelectionIndex(-1, 1, 3)).toBe(0);
    expect(resolveBrowserHistorySelectionIndex(-1, -1, 3)).toBe(2);
    expect(resolveBrowserHistorySelectionIndex(2, 1, 3)).toBe(0);
    expect(resolveBrowserHistorySelectionIndex(0, -1, 3)).toBe(2);
    expect(resolveBrowserHistorySelectionIndex(0, 1, 0)).toBe(-1);
  });

  it("persists and removes normalized flat bookmarks", () => {
    const added = toggleBrowserBookmark({
      url: "https://user:password@example.com/path#section",
      title: "Example",
    });

    expect(added).toEqual([
      expect.objectContaining({ url: "https://example.com/path", title: "Example" }),
    ]);
    expect(getBrowserBookmarks()).toEqual(added);
    expect(toggleBrowserBookmark({ url: "https://example.com/path", title: "Example" })).toEqual(
      [],
    );
    expect(getBrowserBookmarks()).toEqual([]);
  });

  it("synchronizes history and bookmark changes across mounted subscribers", () => {
    let firstHistory = getBrowserHistory();
    let secondHistory = getBrowserHistory();
    let firstBookmarks = getBrowserBookmarks();
    let secondBookmarks = getBrowserBookmarks();
    const syncFirst = () => {
      firstHistory = getBrowserHistory();
      firstBookmarks = getBrowserBookmarks();
    };
    const syncSecond = () => {
      secondHistory = getBrowserHistory();
      secondBookmarks = getBrowserBookmarks();
    };
    const unsubscribeFirst = subscribeBrowserData(syncFirst);
    const unsubscribeSecond = subscribeBrowserData(syncSecond);

    recordBrowserHistoryVisit({ url: "https://example.com", title: "Example" });
    toggleBrowserBookmark({ url: "https://example.com", title: "Example" });

    expect(firstHistory).toEqual(secondHistory);
    expect(filterBrowserHistory(secondHistory, "example")).toEqual(["https://example.com/"]);
    expect(firstBookmarks).toEqual(secondBookmarks);
    expect(secondBookmarks).toHaveLength(1);

    toggleBrowserBookmark({ url: "https://example.com", title: "Example" });
    expect(firstBookmarks).toEqual([]);
    expect(secondBookmarks).toEqual([]);

    unsubscribeFirst();
    unsubscribeSecond();
  });
});
