import { describe, expect, it } from "vitest";

import { getKanbanWatchRoots, getNotesWatchRoots } from "./storageRoots";

const storage = {
  notesDir: "/tmp/state/notes",
  kanbanDir: "/tmp/state/kanban",
};

describe("getNotesWatchRoots", () => {
  it("watches both global and project note directories in global scope", () => {
    expect(getNotesWatchRoots(storage, "project-1", "global")).toEqual([
      "/tmp/state/notes/global",
      "/tmp/state/notes/project-1",
    ]);
  });

  it("watches only the project note directory in project scope", () => {
    expect(getNotesWatchRoots(storage, "project-1", "project")).toEqual([
      "/tmp/state/notes/project-1",
    ]);
  });
});

describe("getKanbanWatchRoots", () => {
  it("watches only the global kanban directory in global scope", () => {
    expect(getKanbanWatchRoots(storage, "project-1", "global")).toEqual([
      "/tmp/state/kanban/global",
    ]);
  });

  it("watches only the project kanban directory in project scope", () => {
    expect(getKanbanWatchRoots(storage, "project-1", "project")).toEqual([
      "/tmp/state/kanban/project-1",
    ]);
  });
});
