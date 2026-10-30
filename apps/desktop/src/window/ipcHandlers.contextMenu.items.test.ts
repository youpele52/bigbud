import { describe, expect, it } from "vitest";

import {
  CONTEXT_MENU_MAX_ITEMS_PER_LEVEL,
  buildContextMenuTemplate,
  normalizeContextMenuItems,
} from "./ipcHandlers.contextMenu.items";

describe("context menu items", () => {
  it("keeps one submenu level with checked items and drops deeper levels", () => {
    const items = normalizeContextMenuItems([
      {
        id: "move",
        label: "Move to",
        children: [
          { id: "move:present", label: "Present", checked: true },
          { id: "move:done", label: "Done", checked: false, children: [{ id: "x", label: "X" }] },
        ],
      },
    ]);
    expect(items[0]?.children.map((child) => [child.id, child.checked])).toEqual([
      ["move:present", true],
      ["move:done", false],
    ]);
    expect(items[0]?.children[1]?.children).toEqual([]);
  });

  it("bounds item counts and drops duplicate or malformed ids", () => {
    const many = Array.from({ length: CONTEXT_MENU_MAX_ITEMS_PER_LEVEL + 5 }, (_, index) => ({
      id: `item-${index}`,
      label: `Item ${index}`,
    }));
    expect(normalizeContextMenuItems(many)).toHaveLength(CONTEXT_MENU_MAX_ITEMS_PER_LEVEL);
    expect(
      normalizeContextMenuItems([
        { id: "a", label: "A" },
        { id: "a", label: "Again" },
        { id: 3, label: "Bad" },
        null,
      ]).map((item) => item.label),
    ).toEqual(["A"]);
  });

  it("never repeats, leads, or trails separators around destructive items", () => {
    const template = buildContextMenuTemplate(
      normalizeContextMenuItems([
        { id: "sep-0", label: "", separator: true },
        { id: "rename", label: "Rename" },
        { id: "sep-1", label: "", separator: true },
        { id: "delete", label: "Delete", destructive: true },
        { id: "sep-2", label: "", separator: true },
      ]),
    );
    expect(template.map((item) => item.type ?? item.label)).toEqual([
      "Rename",
      "separator",
      "Delete",
    ]);
  });

  it("renders checked choices as checkboxes inside a submenu", () => {
    const [moveTo] = buildContextMenuTemplate(
      normalizeContextMenuItems([
        {
          id: "move",
          label: "Move to",
          children: [{ id: "move:later", label: "Later", checked: true }],
        },
      ]),
    );
    expect(moveTo?.submenu?.[0]).toMatchObject({
      type: "checkbox",
      checked: true,
      id: "move:later",
    });
  });
});
