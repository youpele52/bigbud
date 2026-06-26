import { describe, expect, it, vi } from "vitest";

import {
  createDebouncedDirectoryRefresh,
  refreshVisibleDirectories,
} from "./useFilesPanelDirectoryRefresh.logic";

describe("refreshVisibleDirectories", () => {
  it("forces a reload for every visible directory path", () => {
    const loadDirectory = vi.fn();

    refreshVisibleDirectories(["", "docs", "docs/plan"], loadDirectory);

    expect(loadDirectory).toHaveBeenCalledTimes(3);
    expect(loadDirectory).toHaveBeenNthCalledWith(1, "", { force: true });
    expect(loadDirectory).toHaveBeenNthCalledWith(2, "docs", { force: true });
    expect(loadDirectory).toHaveBeenNthCalledWith(3, "docs/plan", { force: true });
  });
});

describe("createDebouncedDirectoryRefresh", () => {
  it("debounces visible directory reloads", () => {
    vi.useFakeTimers();
    const loadDirectory = vi.fn();
    const getVisibleDirectoryPaths = vi.fn().mockReturnValue(["docs", "docs/plan"]);

    const refresh = createDebouncedDirectoryRefresh(loadDirectory, getVisibleDirectoryPaths, 100);

    refresh.schedule();
    refresh.schedule();
    expect(loadDirectory).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(loadDirectory).toHaveBeenCalledTimes(2);
    expect(loadDirectory).toHaveBeenNthCalledWith(1, "docs", { force: true });
    expect(loadDirectory).toHaveBeenNthCalledWith(2, "docs/plan", { force: true });

    refresh.cancel();
    vi.useRealTimers();
  });

  it("cancels a pending visible directory reload", () => {
    vi.useFakeTimers();
    const loadDirectory = vi.fn();
    const refresh = createDebouncedDirectoryRefresh(loadDirectory, () => ["docs"], 100);

    refresh.schedule();
    refresh.cancel();
    vi.advanceTimersByTime(100);

    expect(loadDirectory).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
