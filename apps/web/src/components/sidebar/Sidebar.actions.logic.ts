export const SIDEBAR_ACTION_IDS = [
  "plugins",
  "scheduled",
  "games",
  "usage",
  "pinned",
  "chats",
  "projects",
  "remote-projects",
] as const;
export type SidebarActionId = (typeof SIDEBAR_ACTION_IDS)[number];
export const SIDEBAR_PRIMARY_GROUP_SIZE = 4;

export const SIDEBAR_ACTION_LABELS: Record<SidebarActionId, string> = {
  plugins: "Plugins",
  scheduled: "Scheduled",
  games: "Games",
  usage: "Usage",
  pinned: "Pinned",
  chats: "Chats",
  projects: "Projects",
  "remote-projects": "Remote Projects",
};

export function isSidebarActionId(value: unknown): value is SidebarActionId {
  return SIDEBAR_ACTION_IDS.some((id) => id === value);
}

export function sanitizeSidebarActionOrder(value: unknown): SidebarActionId[] {
  const saved = Array.isArray(value) ? value.filter(isSidebarActionId) : [];
  return [...new Set(saved), ...SIDEBAR_ACTION_IDS.filter((id) => !saved.includes(id))];
}

export function sanitizeHiddenSidebarActions(value: unknown): SidebarActionId[] {
  return Array.isArray(value) ? [...new Set(value.filter(isSidebarActionId))] : [];
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
): { primary: SidebarActionId[]; secondary: SidebarActionId[] } {
  const visibleIds = new Set(visible);
  return {
    primary: order.slice(0, SIDEBAR_PRIMARY_GROUP_SIZE).filter((id) => visibleIds.has(id)),
    secondary: order.slice(SIDEBAR_PRIMARY_GROUP_SIZE).filter((id) => visibleIds.has(id)),
  };
}
