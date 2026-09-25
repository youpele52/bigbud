import { describe, expect, it } from "vitest";
import { SIDEBAR_ACTION_IDS } from "./Sidebar.actions.logic";
import { buildSidebarItemMenuItems } from "./Sidebar.actions.menu";

describe("sidebar item context menu", () => {
  it("offers both edge moves for a middle section", () => {
    const items = buildSidebarItemMenuItems({
      id: "projects",
      order: ["projects", ...SIDEBAR_ACTION_IDS.filter((id) => id !== "projects")],
      visible: ["plugins", "pinned", "projects", "remote-projects"],
      hidden: ["chats"],
    });
    expect(items).toContainEqual({ id: "hide", label: "Hide Projects" });
    expect(items).toContainEqual({ id: "move-top", label: "Move to top", disabled: false });
    expect(items).toContainEqual({ id: "move-bottom", label: "Move to bottom", disabled: false });
    expect(items).toContainEqual({ id: "show:chats", label: "Show Chats" });
    expect(items).toContainEqual({ id: "reset-order", label: "Reset order", disabled: false });
    expect(items.map((item) => item.id)).toEqual([
      "hide",
      "",
      "move-up",
      "move-down",
      "move-top",
      "move-bottom",
      "",
      "show:chats",
      "",
      "hide-all",
      "show-all",
      "",
      "reset-order",
    ]);
  });

  it("disables moves beyond visible list edges and keeps recovery available", () => {
    const items = buildSidebarItemMenuItems({
      id: "pinned",
      order: SIDEBAR_ACTION_IDS,
      visible: ["pinned", "projects"],
      hidden: ["plugins", "chats"],
    });
    expect(items.find((item) => item.id === "move-top")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "move-bottom")?.disabled).toBe(false);
    expect(items.find((item) => item.id === "reset-order")?.disabled).toBe(true);
    const recovery = buildSidebarItemMenuItems({
      id: null,
      order: SIDEBAR_ACTION_IDS,
      visible: [],
      hidden: ["plugins", "pinned", "chats", "projects", "remote-projects"],
    });
    expect(recovery.some((item) => item.id === "show-all" && !item.disabled)).toBe(true);
    expect(recovery[0]?.id).toBe("show:plugins");
    expect(recovery.at(-1)?.id).toBe("reset-order");
    expect(recovery.filter((item) => item.separator)).toHaveLength(2);
  });

  it("omits empty hidden-item groups from the menu", () => {
    const items = buildSidebarItemMenuItems({
      id: null,
      order: SIDEBAR_ACTION_IDS,
      visible: SIDEBAR_ACTION_IDS,
      hidden: [],
    });
    expect(items.map((item) => item.id)).toEqual(["hide-all", "show-all", "", "reset-order"]);
  });
});
