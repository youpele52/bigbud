import {
  SIDEBAR_ACTION_IDS,
  SIDEBAR_ACTION_LABELS,
  type SidebarActionId,
} from "./Sidebar.actions.logic";

interface SidebarMenuItem {
  id: string;
  label: string;
  separator?: boolean;
  disabled?: boolean;
}

const separator = (): SidebarMenuItem => ({ id: "", label: "", separator: true });

export function buildSidebarItemMenuItems(input: {
  id: SidebarActionId | null;
  order: readonly SidebarActionId[];
  visible: readonly SidebarActionId[];
  hidden: readonly SidebarActionId[];
}): SidebarMenuItem[] {
  const { id, order, visible, hidden } = input;
  const index = id === null ? -1 : visible.indexOf(id);
  return [
    ...(id
      ? [
          { id: "hide", label: `Hide ${SIDEBAR_ACTION_LABELS[id]}` },
          separator(),
          { id: "move-up", label: "Move up", disabled: index <= 0 },
          { id: "move-down", label: "Move down", disabled: index >= visible.length - 1 },
          { id: "move-top", label: "Move to top", disabled: index <= 0 },
          { id: "move-bottom", label: "Move to bottom", disabled: index >= visible.length - 1 },
          separator(),
        ]
      : []),
    ...hidden.map((entry) => ({
      id: `show:${entry}`,
      label: `Show ${SIDEBAR_ACTION_LABELS[entry]}`,
    })),
    ...(hidden.length > 0 ? [separator()] : []),
    { id: "hide-all", label: "Hide all", disabled: visible.length === 0 },
    { id: "show-all", label: "Show all", disabled: hidden.length === 0 },
    separator(),
    {
      id: "reset-order",
      label: "Reset order",
      disabled: order.every((entry, index) => entry === SIDEBAR_ACTION_IDS[index]),
    },
  ];
}
