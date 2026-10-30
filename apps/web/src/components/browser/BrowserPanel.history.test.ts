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
  getBrowserHistory,
  recordBrowserHistoryVisit,
  subscribeBrowserData,
  updateBrowserHistoryVisitMetadata,
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

  it("synchronizes history changes across mounted subscribers", () => {
    let firstHistory = getBrowserHistory();
    let secondHistory = getBrowserHistory();
    const syncFirst = () => {
      firstHistory = getBrowserHistory();
    };
    const syncSecond = () => {
      secondHistory = getBrowserHistory();
    };
    const unsubscribeFirst = subscribeBrowserData(syncFirst);
    const unsubscribeSecond = subscribeBrowserData(syncSecond);

    recordBrowserHistoryVisit({ url: "https://example.com", title: "Example" });

    expect(firstHistory).toEqual(secondHistory);
    expect(filterBrowserHistory(secondHistory, "example")).toEqual(["https://example.com/"]);

    unsubscribeFirst();
    unsubscribeSecond();
  });

  it("persists observed icons without counting metadata changes as visits", () => {
    recordBrowserHistoryVisit({ url: "https://example.com/", title: "" });
    updateBrowserHistoryVisitMetadata("https://example.com/", {
      title: "",
      faviconUrl: "https://example.com/icon.png",
    });
    expect(getBrowserHistory()[0]).toMatchObject({
      title: "",
      faviconUrl: "https://example.com/icon.png",
      visitCount: 1,
    });
    updateBrowserHistoryVisitMetadata("https://example.com/", {
      title: "Example",
      faviconUrl: null,
    });
    expect(getBrowserHistory()[0]).toMatchObject({
      title: "Example",
      faviconUrl: "https://example.com/icon.png",
      visitCount: 1,
    });
    recordBrowserHistoryVisit({ url: "https://example.com/", title: "" });
    expect(getBrowserHistory()[0]).toMatchObject({
      faviconUrl: "https://example.com/icon.png",
      visitCount: 2,
    });
  });

  it("keeps existing v2 records compatible and removes unsafe stored icons", () => {
    const [visit] = resolveNextBrowserHistory([], {
      url: "https://example.com/",
      title: "Example",
    });
    expect(migrateBrowserHistory({ version: 2, visits: [visit] })).toEqual([visit]);
    expect(
      migrateBrowserHistory({
        version: 2,
        visits: [{ ...visit, faviconUrl: "javascript:alert(1)" }],
      }),
    ).toEqual([visit]);
  });

  it("does not write unchanged metadata or create phantom history entries", () => {
    recordBrowserHistoryVisit({ url: "https://example.com/", title: "Example" });
    browserStorageMock.set.mockClear();
    updateBrowserHistoryVisitMetadata("https://example.com/", { title: "", faviconUrl: null });
    updateBrowserHistoryVisitMetadata("https://not-visited.com/", {
      title: "Other",
      faviconUrl: "https://not-visited.com/icon.png",
    });
    expect(browserStorageMock.set).not.toHaveBeenCalled();
  });
});
