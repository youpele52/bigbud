import { describe, expect, it } from "vitest";
import {
  reorderSidebarAction,
  moveSidebarActionToEdge,
  sanitizeHiddenSidebarActions,
  sanitizeSidebarActionOrder,
  sidebarVisualGroups,
} from "./Sidebar.actions.logic";

describe("sidebar action preferences", () => {
  it("restores a valid saved order and appends new actions", () => {
    expect(sanitizeSidebarActionOrder(["usage", "plugins", "usage", "new-chat", "search"])).toEqual(
      ["usage", "plugins", "scheduled", "games", "pinned", "chats", "projects", "remote-projects"],
    );
  });

  it("ignores unknown hidden items and permits all configurable actions to be hidden", () => {
    expect(
      sanitizeHiddenSidebarActions([
        "plugins",
        "scheduled",
        "games",
        "usage",
        "pinned",
        "chats",
        "projects",
        "remote-projects",
        "search",
        "new-chat",
      ]),
    ).toEqual([
      "plugins",
      "scheduled",
      "games",
      "usage",
      "pinned",
      "chats",
      "projects",
      "remote-projects",
    ]);
  });

  it("moves sections to either edge without involving the fixed actions", () => {
    const order = sanitizeSidebarActionOrder([
      "plugins",
      "pinned",
      "chats",
      "projects",
      "remote-projects",
    ]);
    expect(moveSidebarActionToEdge(order, "remote-projects", "top")[0]).toBe("remote-projects");
    expect(moveSidebarActionToEdge(order, "pinned", "bottom").at(-1)).toBe("pinned");
  });

  it("reorders a dragged action to another action's position", () => {
    expect(
      reorderSidebarAction(["plugins", "scheduled", "games", "usage"], "usage", "scheduled"),
    ).toEqual(["plugins", "usage", "scheduled", "games"]);
  });

  it("keeps four ordered slots in each visual group when items move or hide", () => {
    const initial = sanitizeSidebarActionOrder([]);
    expect(sidebarVisualGroups(initial, initial)).toEqual({
      primary: ["plugins", "scheduled", "games", "usage"],
      secondary: ["pinned", "chats", "projects", "remote-projects"],
    });
    const moved = reorderSidebarAction(initial, "pinned", "scheduled");
    expect(sidebarVisualGroups(moved, moved).primary).toEqual([
      "plugins",
      "pinned",
      "scheduled",
      "games",
    ]);
    expect(sidebarVisualGroups(moved, moved).secondary[0]).toBe("usage");
    expect(
      sidebarVisualGroups(
        moved,
        moved.filter((id) => id !== "scheduled"),
      ).primary,
    ).toEqual(["plugins", "pinned", "games"]);
  });
});
