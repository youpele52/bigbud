import { describe, expect, it } from "vitest";
import {
  reorderSidebarAction,
  moveSidebarActionToEdge,
  sanitizeHiddenSidebarActions,
  sanitizeSidebarActionOrder,
  sanitizeSidebarPrimaryGroupSize,
  sidebarVisualGroups,
} from "./Sidebar.actions.logic";

describe("sidebar action preferences", () => {
  it("restores a valid saved order and appends new actions", () => {
    expect(sanitizeSidebarActionOrder(["usage", "plugins", "usage", "new-chat", "search"])).toEqual(
      [
        "usage",
        "resource-monitor",
        "scheduled",
        "games",
        "pinned",
        "chats",
        "projects",
        "remote-workspaces",
      ],
    );
  });

  it("ignores unknown hidden items and permits all configurable actions to be hidden", () => {
    expect(
      sanitizeHiddenSidebarActions([
        "plugins",
        "scheduled",
        "games",
        "usage",
        "resource-monitor",
        "pinned",
        "chats",
        "projects",
        "remote-workspaces",
        "search",
        "new-chat",
      ]),
    ).toEqual([
      "scheduled",
      "games",
      "usage",
      "resource-monitor",
      "pinned",
      "chats",
      "projects",
      "remote-workspaces",
    ]);
  });

  it("moves sections to either edge without involving the fixed actions", () => {
    const order = sanitizeSidebarActionOrder([
      "plugins",
      "pinned",
      "chats",
      "projects",
      "remote-workspaces",
    ]);
    expect(moveSidebarActionToEdge(order, "remote-workspaces", "top")[0]).toBe("remote-workspaces");
    expect(moveSidebarActionToEdge(order, "pinned", "bottom").at(-1)).toBe("pinned");
  });

  it("reorders a dragged action to another action's position", () => {
    expect(reorderSidebarAction(["scheduled", "games", "usage"], "usage", "scheduled")).toEqual([
      "usage",
      "scheduled",
      "games",
    ]);
  });

  it("keeps System Monitor in the default first group after Usage", () => {
    const initial = sanitizeSidebarActionOrder([]);
    expect(sidebarVisualGroups(initial, initial)).toEqual({
      primary: ["scheduled", "games", "usage", "resource-monitor"],
      secondary: ["pinned", "chats", "projects", "remote-workspaces"],
    });
    const moved = reorderSidebarAction(initial, "pinned", "scheduled");
    expect(sidebarVisualGroups(moved, moved).primary).toEqual([
      "pinned",
      "scheduled",
      "games",
      "usage",
    ]);
    expect(sidebarVisualGroups(moved, moved).secondary[0]).toBe("resource-monitor");
    expect(
      sidebarVisualGroups(
        moved,
        moved.filter((id) => id !== "scheduled"),
      ).primary,
    ).toEqual(["pinned", "games", "usage"]);
  });

  it("preserves a custom group boundary when the retired action was secondary", () => {
    const legacy = [
      "scheduled",
      "games",
      "usage",
      "resource-monitor",
      "pinned",
      "plugins",
      "chats",
      "projects",
      "remote-workspaces",
    ];
    const order = sanitizeSidebarActionOrder(legacy);
    const size = sanitizeSidebarPrimaryGroupSize(undefined, legacy);
    expect(size).toBe(5);
    expect(sidebarVisualGroups(order, order, size)).toEqual({
      primary: ["scheduled", "games", "usage", "resource-monitor", "pinned"],
      secondary: ["chats", "projects", "remote-workspaces"],
    });
    expect(sanitizeSidebarPrimaryGroupSize(5, order)).toBe(5);
    expect(sanitizeSidebarPrimaryGroupSize(undefined, ["plugins", ...order])).toBe(4);
    expect(sanitizeHiddenSidebarActions(["plugins", "usage", "plugins"])).toEqual(["usage"]);
  });
});
