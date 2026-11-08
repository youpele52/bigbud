import { ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../models/types/app.types";
import { buildInyosiraMoveMenuItem } from "./Sidebar.inyosira.menu";
import {
  BIGBUD_INYOSIRA_THREAD_DRAG_MIME,
  groupInyosiraThreadIds,
  previewInyosiraThreadIds,
  readInyosiraDragThreadId,
  resolveInyosiraLocation,
  visibleInyosiraThreadIds,
} from "./Sidebar.inyosira.logic";

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

describe("Inyosira grouping", () => {
  it("groups active threads by state, newest first, defaulting to Present", () => {
    const groups = groupInyosiraThreadIds({
      a: summary("a", { latestUserMessageAt: "2026-10-30T01:00:00.000Z" }),
      b: summary("b", { latestUserMessageAt: "2026-10-30T02:00:00.000Z" }),
      c: summary("c", { organization: org("done") }),
      d: summary("d", { organization: org("done"), archivedAt: "2026-10-30T00:00:00.000Z" }),
      e: summary("e", { organization: org("needs-you"), deletingAt: "2026-10-30T00:00:00.000Z" }),
    });
    expect(groups).toEqual({ present: ["b", "a"], "needs-you": [], later: [], done: ["c"] });
    expect(visibleInyosiraThreadIds(groups, ["present"])).toEqual(["c"]);
  });

  it.each(["present", "needs-you", "later", "done"] as const)(
    "sorts %s by displayed activity, ignoring metadata updates and pins",
    (state) => {
      const groups = groupInyosiraThreadIds({
        oldPinned: summary("old-pinned", {
          organization: org(state),
          latestUserMessageAt: "2026-10-30T01:00:00.000Z",
          updatedAt: "2026-10-31T00:00:00.000Z",
          pinnedAt: "2026-10-31T00:00:00.000Z",
        }),
        recent: summary("recent", {
          organization: org(state),
          latestUserMessageAt: "2026-10-30T22:00:00.000Z",
          updatedAt: "2026-10-30T22:00:00.000Z",
        }),
        middle: summary("middle", {
          organization: org(state),
          latestUserMessageAt: "2026-10-30T11:00:00.000Z",
          updatedAt: "2026-10-30T23:00:00.000Z",
        }),
        newEmpty: summary("new-empty", {
          organization: org(state),
          createdAt: "2026-10-30T23:00:00.000Z",
          updatedAt: undefined,
        }),
      });

      expect(groups[state]).toEqual(["new-empty", "recent", "middle", "old-pinned"]);
      expect(visibleInyosiraThreadIds(groups, [])).toEqual(groups[state]);
    },
  );

  it("uses a deterministic id tie-breaker for equal displayed activity", () => {
    const a = summary("a", { updatedAt: "2026-10-31T00:00:00.000Z" });
    const b = summary("b", { pinnedAt: "2026-10-31T00:00:00.000Z" });

    expect(groupInyosiraThreadIds({ a, b }).present).toEqual(["b", "a"]);
    expect(groupInyosiraThreadIds({ b, a }).present).toEqual(["b", "a"]);
  });

  it("compares activity timestamps chronologically across timezone offsets", () => {
    const groups = groupInyosiraThreadIds({
      a: summary("a", { latestUserMessageAt: "2026-10-30T23:00:00.000+02:00" }),
      b: summary("b", { latestUserMessageAt: "2026-10-30T22:00:00.000Z" }),
    });

    expect(groups.present).toEqual(["b", "a"]);
  });
});

describe("Inyosira thread previews and navigation", () => {
  const ids = Array.from({ length: 8 }, (_, index) => ThreadId.makeUnsafe(`thread-${index}`));

  it("limits the default preview to four rows and expands only on demand", () => {
    expect(previewInyosiraThreadIds(ids, false)).toEqual({
      visibleItems: ids.slice(0, 4),
      hiddenCount: 4,
      totalCount: 8,
    });
    expect(previewInyosiraThreadIds(ids, true).visibleItems).toEqual(ids);
  });

  it("keeps the active row outside the preview in its sorted position", () => {
    const preview = previewInyosiraThreadIds(ids, false, ids[7]);
    expect(preview.visibleItems).toEqual([...ids.slice(0, 4), ids[7]]);
    expect(preview.hiddenCount).toBe(3);
    expect(previewInyosiraThreadIds(ids, false, ids[0]).visibleItems).toEqual(ids.slice(0, 4));
  });

  it("does not add missing active threads or duplicate IDs", () => {
    expect(
      previewInyosiraThreadIds([...ids, ids[0]!], false, ThreadId.makeUnsafe("other")),
    ).toEqual({
      visibleItems: ids.slice(0, 4),
      hiddenCount: 4,
      totalCount: 8,
    });
    expect(previewInyosiraThreadIds([], false).visibleItems).toEqual([]);
  });

  it("keeps traversal and numbered jumps aligned with mounted rows in every group", () => {
    const groups = {
      present: ids,
      "needs-you": [],
      later: ids.map((id) => ThreadId.makeUnsafe(`later-${id}`)),
      done: [ThreadId.makeUnsafe("done")],
    };
    expect(visibleInyosiraThreadIds(groups, ["done"], [], ids[7])).toEqual([
      ...ids.slice(0, 4),
      ids[7],
      ...groups.later.slice(0, 4),
    ]);
    expect(visibleInyosiraThreadIds(groups, ["present", "done"], ["later"], ids[7])).toEqual(
      groups.later,
    );
    expect(visibleInyosiraThreadIds(groups, ["later", "done"], ["present"])).toEqual(ids);
  });
});

describe("Inyosira location", () => {
  it("names Chat, local projects, and remote workspaces", () => {
    expect(
      resolveInyosiraLocation(
        summary("a", { projectId: ProjectId.makeUnsafe("__chats__") }),
        undefined,
      ),
    ).toEqual({
      kind: "chat",
      label: "Chat",
    });
    expect(resolveInyosiraLocation(summary("a"), { name: "bigbud" })).toEqual({
      kind: "local",
      label: "bigbud",
    });
    expect(
      resolveInyosiraLocation(summary("a", { workspaceExecutionTargetId: "ssh:me@vps.example" }), {
        name: "VPS app",
      }),
    ).toEqual({ kind: "remote", label: "VPS app" });
    expect(resolveInyosiraLocation(summary("a"), undefined)).toEqual({
      kind: "local",
      label: "Project",
    });
  });
});

describe("Inyosira drag and menu", () => {
  it("accepts only known thread ids from the Inyosira drag payload", () => {
    const data = (value: string) => ({
      getData: (type: string) => (type === BIGBUD_INYOSIRA_THREAD_DRAG_MIME ? value : ""),
    });
    expect(readInyosiraDragThreadId(data("a"), new Set(["a"]))).toBe("a");
    expect(readInyosiraDragThreadId(data("forged"), new Set(["a"]))).toBeNull();
  });

  it("offers only destinations and checks the current state only for one thread", () => {
    const single = buildInyosiraMoveMenuItem(org("later"));
    expect(single.children?.map((item) => [item.label, item.checked])).toEqual([
      ["Needs you", false],
      ["Present", false],
      ["Later", true],
      ["Done", false],
    ]);
    expect(single.children).toHaveLength(4);
    const many = buildInyosiraMoveMenuItem(null);
    expect(many.children?.map((item) => item.label)).toEqual([
      "Needs you",
      "Present",
      "Later",
      "Done",
    ]);
    expect(many.children?.every((item) => item.checked === undefined)).toBe(true);
  });
});
