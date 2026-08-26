import { describe, expect, it, vi } from "vitest";

import {
  createFilesPanelRefreshCoordinator,
  FILES_PANEL_REFRESH_DEBOUNCE_MS,
  FILES_PANEL_REFRESH_MAX_WAIT_MS,
  getPrioritizedWatchedDirectoryPaths,
  getWatchedDirectoryPathSetKey,
  getWorkspaceDirectoryWatchErrorAction,
  shouldRefreshPreviewForDirectoryEvent,
} from "./FilesPanelRefreshCoordinator.logic";

describe("createFilesPanelRefreshCoordinator", () => {
  it("subscribes the active directory before root and other expanded directories", () => {
    expect(getPrioritizedWatchedDirectoryPaths(["", "src", "docs/api"], "docs")).toEqual([
      "docs",
      "",
      "docs/api",
      "src",
    ]);
    expect(getPrioritizedWatchedDirectoryPaths(["", "src"], "")).toEqual(["", "src"]);
  });

  it("uses a stable key for equivalent ordered watch path sets", () => {
    expect(getWatchedDirectoryPathSetKey(["docs", "", "src"])).toBe(
      getWatchedDirectoryPathSetKey(["docs", "", "src"]),
    );
    expect(getWatchedDirectoryPathSetKey(["", "docs"])).not.toBe(
      getWatchedDirectoryPathSetKey(["docs", ""]),
    );
  });

  it("reconciles only confirmed missing child watches", () => {
    expect(
      getWorkspaceDirectoryWatchErrorAction(
        "workspace",
        new Error("NOT_FOUND: workspace path was not found: workspace"),
      ),
    ).toBe("reconcileChild");
    expect(
      getWorkspaceDirectoryWatchErrorAction(
        "",
        new Error("NOT_FOUND: workspace path was not found"),
      ),
    ).toBe("reportUnavailable");
    expect(getWorkspaceDirectoryWatchErrorAction("docs", new Error("WebSocket disconnected"))).toBe(
      "reportUnavailable",
    );
  });

  it("uses exact remote paths while retaining broad local invalidations", () => {
    expect(
      shouldRefreshPreviewForDirectoryEvent(
        {
          version: 2,
          type: "directoryChanged",
          relativePath: "docs",
          changedPaths: ["docs/other.md"],
          generation: 1,
          sequence: 1,
        },
        "docs/README.md",
        "docs",
      ),
    ).toBe(false);
    expect(
      shouldRefreshPreviewForDirectoryEvent(
        { version: 1, type: "directoryChanged", relativePath: "docs" },
        "docs/README.md",
        "docs",
      ),
    ).toBe(true);
  });

  it("runs higher-priority work first and deduplicates queued keys", async () => {
    vi.useFakeTimers();
    const completed: string[] = [];
    const coordinator = createFilesPanelRefreshCoordinator();

    coordinator.schedule({
      key: "root",
      priority: 20,
      run: () => {
        completed.push("root");
      },
    });
    coordinator.schedule({
      key: "preview",
      priority: 0,
      run: () => {
        completed.push("preview");
      },
    });
    coordinator.schedule({
      key: "preview",
      priority: 0,
      run: () => {
        completed.push("preview-latest");
      },
    });
    coordinator.schedule({
      key: "parent",
      priority: 10,
      run: () => {
        completed.push("parent");
      },
    });

    await vi.advanceTimersByTimeAsync(FILES_PANEL_REFRESH_DEBOUNCE_MS);
    expect(completed).toEqual(["preview-latest", "parent", "root"]);
    coordinator.dispose();
    vi.useRealTimers();
  });

  it("runs aged lower-priority work despite a stream of higher-priority events", async () => {
    vi.useFakeTimers();
    const completed: string[] = [];
    const coordinator = createFilesPanelRefreshCoordinator();

    coordinator.schedule({
      key: "directory",
      priority: 30,
      run: () => {
        completed.push("directory");
      },
    });
    await vi.advanceTimersByTimeAsync(FILES_PANEL_REFRESH_MAX_WAIT_MS);
    coordinator.schedule({
      key: "preview",
      priority: 0,
      run: () => {
        completed.push("preview");
      },
    });
    await vi.advanceTimersByTimeAsync(FILES_PANEL_REFRESH_DEBOUNCE_MS);

    expect(completed).toContain("directory");
    expect(completed).toContain("preview");
    coordinator.dispose();
    vi.useRealTimers();
  });

  it("waits for an in-flight task before starting the next task", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed: string[] = [];
    const coordinator = createFilesPanelRefreshCoordinator();

    coordinator.schedule({
      key: "preview",
      priority: 0,
      run: async () => {
        completed.push("preview-start");
        await first;
        completed.push("preview-end");
      },
    });
    coordinator.schedule({
      key: "root",
      priority: 20,
      run: () => {
        completed.push("root");
      },
    });

    await vi.advanceTimersByTimeAsync(FILES_PANEL_REFRESH_DEBOUNCE_MS);
    expect(completed).toEqual(["preview-start"]);
    release?.();
    await vi.runAllTimersAsync();
    expect(completed).toEqual(["preview-start", "preview-end", "root"]);
    coordinator.dispose();
    vi.useRealTimers();
  });

  it("cancels queued work", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const coordinator = createFilesPanelRefreshCoordinator();
    coordinator.schedule({ key: "root", priority: 20, run });
    coordinator.cancel("root");

    await vi.advanceTimersByTimeAsync(FILES_PANEL_REFRESH_MAX_WAIT_MS);
    expect(run).not.toHaveBeenCalled();
    coordinator.dispose();
    vi.useRealTimers();
  });
});
