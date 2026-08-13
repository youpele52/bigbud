import { describe, expect, it } from "vitest";

import {
  canMoveFileHistory,
  emptyFileHistory,
  moveFileHistory,
  normalizeFileHistory,
  openFileInHistory,
  removeFileFromHistory,
} from "./filesPanel.history";

const file = (path: string) => ({ path, position: null, scrollTop: null });

describe("files panel history", () => {
  it("keeps five entries and evicts the oldest", () => {
    let history = emptyFileHistory();
    for (const path of ["a", "b", "c", "d", "e", "f"]) {
      history = openFileInHistory(history, file(path));
    }
    expect(history.entries.map((entry) => entry.path)).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("truncates forward history after opening a new file", () => {
    let history = emptyFileHistory();
    for (const path of ["a", "b", "c"]) history = openFileInHistory(history, file(path));
    history = moveFileHistory(history, -1);
    history = openFileInHistory(history, file("d"));
    expect(history.entries.map((entry) => entry.path)).toEqual(["a", "b", "d"]);
    expect(canMoveFileHistory(history, 1)).toBe(false);
  });

  it("does not duplicate the current file", () => {
    let history = openFileInHistory(emptyFileHistory(), file("a"));
    history = openFileInHistory(history, file("a"));
    expect(history.entries).toHaveLength(1);
  });

  it("removes missing files and keeps the current entry selected", () => {
    let history = emptyFileHistory();
    for (const path of ["a", "b", "c"]) history = openFileInHistory(history, file(path));
    history = removeFileFromHistory(history, "b");
    expect(history.entries.map((entry) => entry.path)).toEqual(["a", "c"]);
    expect(history.entries[history.index]?.path).toBe("c");
  });

  it("normalizes the index when the current or final entry is removed", () => {
    let history = emptyFileHistory();
    for (const path of ["a", "b", "c"]) history = openFileInHistory(history, file(path));
    history = moveFileHistory(history, -1);
    history = removeFileFromHistory(history, "b");
    expect(history.entries[history.index]?.path).toBe("c");
    history = removeFileFromHistory(history, "c");
    expect(history.entries[history.index]?.path).toBe("a");
    history = removeFileFromHistory(history, "a");
    expect(history).toEqual(emptyFileHistory());
  });

  it("recovers safely from malformed persisted history", () => {
    expect(normalizeFileHistory({ entries: "bad", index: 4 })).toEqual(emptyFileHistory());
    expect(
      normalizeFileHistory({
        entries: [file("a"), { path: 42 }, { path: "b", scrollTop: -1 }],
        index: 99,
      }),
    ).toEqual({
      entries: [file("a"), file("b")],
      index: 1,
    });
  });
});
