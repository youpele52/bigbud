import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../models/types/app.types";
import { buildItutuMoveMenuItem } from "./Sidebar.itutu.menu";
import {
  BIGBUD_ITUTU_THREAD_DRAG_MIME,
  groupItutuThreadIds,
  readItutuDragThreadId,
  resolveItutuLocation,
  visibleItutuThreadIds,
} from "./Sidebar.itutu.logic";

const summary = (
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary => ({
  id: ThreadId.makeUnsafe(id),
  projectId: ProjectId.makeUnsafe("project-1"),
  title: id,
  interactionMode: "default",
  session: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const org = (state: "present" | "needs-you" | "later" | "done") => ({
  state,
  revision: 1,
  changedAt: null,
  snooze: null,
});

describe("Ìtútù grouping", () => {
  it("groups active threads by state, newest first, defaulting to Present", () => {
    const groups = groupItutuThreadIds({
      a: summary("a", { updatedAt: "2026-10-30T01:00:00.000Z" }),
      b: summary("b", { updatedAt: "2026-10-30T02:00:00.000Z" }),
      c: summary("c", { organization: org("done") }),
      d: summary("d", { organization: org("done"), archivedAt: "2026-10-30T00:00:00.000Z" }),
      e: summary("e", { organization: org("needs-you"), deletingAt: "2026-10-30T00:00:00.000Z" }),
    });
    expect(groups).toEqual({ present: ["b", "a"], "needs-you": [], later: [], done: ["c"] });
    expect(visibleItutuThreadIds(groups, ["present"])).toEqual(["c"]);
  });
});

describe("Ìtútù location", () => {
  it("names Chat, local projects, and remote workspaces", () => {
    expect(
      resolveItutuLocation(
        summary("a", { projectId: ProjectId.makeUnsafe("__chats__") }),
        undefined,
      ),
    ).toEqual({
      kind: "chat",
      label: "Chat",
    });
    expect(resolveItutuLocation(summary("a"), { name: "bigbud" })).toEqual({
      kind: "local",
      label: "bigbud",
    });
    expect(
      resolveItutuLocation(summary("a", { workspaceExecutionTargetId: "ssh:me@vps.example" }), {
        name: "VPS app",
      }),
    ).toEqual({ kind: "remote", label: "VPS app" });
    expect(resolveItutuLocation(summary("a"), undefined)).toEqual({
      kind: "local",
      label: "Project",
    });
  });
});

describe("Ìtútù drag and menu", () => {
  it("accepts only known thread ids from the Ìtútù drag payload", () => {
    const data = (value: string) => ({
      getData: (type: string) => (type === BIGBUD_ITUTU_THREAD_DRAG_MIME ? value : ""),
    });
    expect(readItutuDragThreadId(data("a"), new Set(["a"]))).toBe("a");
    expect(readItutuDragThreadId(data("forged"), new Set(["a"]))).toBeNull();
  });

  it("checks the current state and offers snoozing only for one thread", () => {
    const single = buildItutuMoveMenuItem(org("later"));
    expect(single.children?.slice(0, 4).map((item) => [item.label, item.checked])).toEqual([
      ["Present", false],
      ["Needs you", false],
      ["Later", true],
      ["Done", false],
    ]);
    expect(single.children?.some((item) => item.label.startsWith("Snooze"))).toBe(true);
    const many = buildItutuMoveMenuItem(null);
    expect(many.children?.map((item) => item.label)).toEqual([
      "Present",
      "Needs you",
      "Later",
      "Done",
    ]);
    expect(many.children?.every((item) => item.checked === undefined)).toBe(true);
  });
});
