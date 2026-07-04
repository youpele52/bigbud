import { describe, expect, it } from "vitest";

import { normalizeDirectoryWatchRoots } from "./useDirectoryChangeRefresh.logic";

describe("normalizeDirectoryWatchRoots", () => {
  it("deduplicates and sorts watch roots", () => {
    expect(
      normalizeDirectoryWatchRoots(["/tmp/notes", "/tmp/kanban/global", "/tmp/notes/"]),
    ).toEqual(["/tmp/kanban/global", "/tmp/notes"]);
  });

  it("normalizes windows-style roots", () => {
    expect(normalizeDirectoryWatchRoots(["C:\\Users\\me\\notes\\", "C:/Users/me/notes"])).toEqual([
      "C:/Users/me/notes",
    ]);
  });

  it("preserves filesystem roots", () => {
    expect(normalizeDirectoryWatchRoots(["/", "D:\\"])).toEqual(["/", "D:/"]);
  });
});
