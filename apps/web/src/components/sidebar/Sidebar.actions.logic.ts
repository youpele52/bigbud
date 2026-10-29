export const SIDEBAR_ACTION_IDS = [
  "scheduled",
  "games",
  "usage",
  "resource-monitor",
  "pinned",
  "chats",
  "projects",
  "remote-workspaces",
] as const;
export type SidebarActionId = (typeof SIDEBAR_ACTION_IDS)[number];
export const SIDEBAR_PRIMARY_GROUP_SIZE = 4;

export const SIDEBAR_ACTION_LABELS: Record<SidebarActionId, string> = {
  scheduled: "Scheduled",
  games: "Games",
  usage: "Usage",
  "resource-monitor": "System Monitor",
  pinned: "Pinned",
  chats: "Chats",
  projects: "Projects",
  "remote-workspaces": "Remote Workspaces",
};

export function isSidebarActionId(value: unknown): value is SidebarActionId {
  return SIDEBAR_ACTION_IDS.some((id) => id === value);
}

export function sanitizeSidebarActionOrder(value: unknown): SidebarActionId[] {
  const saved = normalizeSavedSidebarActions(value);
  const order = [...new Set(saved)];
  for (const id of SIDEBAR_ACTION_IDS) {
    if (order.includes(id)) continue;
    if (id === "resource-monitor") {
      // Existing saved orders predate this item; keep it beside Usage on upgrade.
      const usageIndex = order.indexOf("usage");
      if (usageIndex >= 0) {
        order.splice(usageIndex + 1, 0, id);
        continue;
      }
    }
    order.push(id);
  }
  return order;
}

function normalizeSavedSidebarActions(value: unknown): SidebarActionId[] {
  if (!Array.isArray(value)) return [];
  // Keep saved visibility and position when upgrading the old section name.
  return value
    .map((id: unknown) => (id === "remote-projects" ? "remote-workspaces" : id))
    .filter(isSidebarActionId);
}

export function sanitizeHiddenSidebarActions(value: unknown): SidebarActionId[] {
  return [...new Set(normalizeSavedSidebarActions(value))];
}

/** Preserve the old positional boundary even when Plugins had been dragged below it. */
export function sanitizeSidebarPrimaryGroupSize(value: unknown, savedOrder: unknown): number {
  if (value === 4 || value === 5) return value;
  if (!Array.isArray(savedOrder) || !savedOrder.includes("plugins"))
    return SIDEBAR_PRIMARY_GROUP_SIZE;
  const legacyOrder = [
    ...new Set(
      savedOrder
        .map((id: unknown) => (id === "remote-projects" ? "remote-workspaces" : id))
        .filter(
          (id): id is SidebarActionId | "plugins" => id === "plugins" || isSidebarActionId(id),
        ),
    ),
  ];
  if (!legacyOrder.includes("resource-monitor") && legacyOrder.includes("usage"))
    legacyOrder.splice(legacyOrder.indexOf("usage") + 1, 0, "resource-monitor");
  return legacyOrder.indexOf("plugins") < 5 ? 4 : 5;
}

export function reorderSidebarAction(
  order: readonly SidebarActionId[],
  dragged: SidebarActionId,
  target: SidebarActionId,
): SidebarActionId[] {
  const from = order.indexOf(dragged);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, dragged);
  return next;
}

export function moveSidebarActionToEdge(
  order: readonly SidebarActionId[],
  id: SidebarActionId,
  edge: "top" | "bottom",
): SidebarActionId[] {
  if (!order.includes(id)) return [...order];
  const remaining = order.filter((entry) => entry !== id);
  return edge === "top" ? [id, ...remaining] : [...remaining, id];
}

export function sidebarVisualGroups(
  order: readonly SidebarActionId[],
  visible: readonly SidebarActionId[],
  primaryGroupSize = SIDEBAR_PRIMARY_GROUP_SIZE,
): { primary: SidebarActionId[]; secondary: SidebarActionId[] } {
  const visibleIds = new Set(visible);
  return {
    primary: order.slice(0, primaryGroupSize).filter((id) => visibleIds.has(id)),
    secondary: order.slice(primaryGroupSize).filter((id) => visibleIds.has(id)),
  };
}
