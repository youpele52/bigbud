import type { PluginCatalogItem } from "@bigbud/contracts";

export const OTHER_PLUGIN_CATEGORY = "Others";

export const PLUGIN_CATEGORY_ORDER = [
  "Creativity",
  "Productivity",
  "Education & Research",
  "Healthcare",
  "Data & Analytics",
  "Entertainment",
  "Developer Tools",
] as const;

const categoryByNormalizedName = new Map(
  PLUGIN_CATEGORY_ORDER.map((category) => [category.toLowerCase(), category]),
);

function displayCategory(category: string | undefined): string {
  const normalizedCategory = category?.trim().toLowerCase();
  return normalizedCategory
    ? (categoryByNormalizedName.get(normalizedCategory) ?? OTHER_PLUGIN_CATEGORY)
    : OTHER_PLUGIN_CATEGORY;
}

export function matchesPlugin(item: PluginCatalogItem, query: string): boolean {
  return `${item.name} ${item.presentation.displayName} ${item.presentation.shortDescription ?? ""} ${item.presentation.longDescription ?? ""} ${item.presentation.developer ?? ""} ${item.presentation.category ?? ""}`
    .toLowerCase()
    .includes(query.trim().toLowerCase());
}

export function groupPluginsByCategory(
  items: ReadonlyArray<PluginCatalogItem>,
): ReadonlyArray<readonly [string, ReadonlyArray<PluginCatalogItem>]> {
  const categories = new Map<string, PluginCatalogItem[]>();
  for (const item of items) {
    const category = displayCategory(item.presentation.category);
    const group = categories.get(category);
    if (group) group.push(item);
    else categories.set(category, [item]);
  }
  return [...categories.entries()].toSorted(([left], [right]) => {
    const leftIndex = PLUGIN_CATEGORY_ORDER.indexOf(left as (typeof PLUGIN_CATEGORY_ORDER)[number]);
    const rightIndex = PLUGIN_CATEGORY_ORDER.indexOf(
      right as (typeof PLUGIN_CATEGORY_ORDER)[number],
    );
    const normalizedLeftIndex = leftIndex === -1 ? PLUGIN_CATEGORY_ORDER.length : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? PLUGIN_CATEGORY_ORDER.length : rightIndex;
    return normalizedLeftIndex - normalizedRightIndex;
  });
}
