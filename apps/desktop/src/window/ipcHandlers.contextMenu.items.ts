import type { ContextMenuItem } from "@bigbud/contracts";

/** Renderer menus are untrusted input: bound their size and depth before building a native menu. */
export const CONTEXT_MENU_MAX_ITEMS_PER_LEVEL = 32;

export interface NormalizedContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly separator: boolean;
  readonly destructive: boolean;
  readonly disabled: boolean;
  readonly checked: boolean | undefined;
  readonly children: readonly NormalizedContextMenuItem[];
}

function normalizeLevel(
  items: unknown,
  depth: number,
  seenIds: Set<string>,
): NormalizedContextMenuItem[] {
  if (!Array.isArray(items)) return [];
  const normalized: NormalizedContextMenuItem[] = [];
  for (const item of items.slice(0, CONTEXT_MENU_MAX_ITEMS_PER_LEVEL) as ContextMenuItem[]) {
    if (!item || typeof item.id !== "string" || typeof item.label !== "string") continue;
    const separator = item.separator === true;
    // Clickable ids must be unique so a click resolves to exactly one action.
    if (!separator && seenIds.has(item.id)) continue;
    if (!separator) seenIds.add(item.id);
    normalized.push({
      id: item.id,
      label: item.label,
      separator,
      destructive: item.destructive === true,
      disabled: item.disabled === true,
      checked: typeof item.checked === "boolean" ? item.checked : undefined,
      children: depth === 0 && !separator ? normalizeLevel(item.children, 1, seenIds) : [],
    });
  }
  return normalized;
}

export function normalizeContextMenuItems(items: unknown): NormalizedContextMenuItem[] {
  return normalizeLevel(items, 0, new Set());
}

export interface ContextMenuTemplateItem {
  readonly type?: "separator" | "checkbox";
  readonly label?: string;
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly destructive?: boolean;
  readonly id?: string;
  readonly submenu?: ContextMenuTemplateItem[];
}

/**
 * Builds a menu template. A separator precedes the first destructive item unless one is already
 * there, and separators never lead, trail, or repeat.
 */
export function buildContextMenuTemplate(
  items: readonly NormalizedContextMenuItem[],
): ContextMenuTemplateItem[] {
  const template: ContextMenuTemplateItem[] = [];
  const lastIsSeparator = () => template.at(-1)?.type === "separator";
  let insertedDestructiveSeparator = false;
  for (const item of items) {
    if (item.separator) {
      if (template.length > 0 && !lastIsSeparator()) template.push({ type: "separator" });
      continue;
    }
    if (item.destructive && !insertedDestructiveSeparator) {
      if (template.length > 0 && !lastIsSeparator()) template.push({ type: "separator" });
      insertedDestructiveSeparator = true;
    }
    if (item.children.length > 0) {
      template.push({
        label: item.label,
        enabled: !item.disabled,
        submenu: buildContextMenuTemplate(item.children),
      });
      continue;
    }
    template.push({
      ...(item.checked !== undefined ? { type: "checkbox" as const, checked: item.checked } : {}),
      id: item.id,
      label: item.label,
      enabled: !item.disabled,
      destructive: item.destructive,
    });
  }
  while (lastIsSeparator()) template.pop();
  return template;
}
