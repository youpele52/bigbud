import { SETTINGS_SEARCH_ITEMS } from "./SettingsSidebarNav.items";

export function normalizeSettingsSearchQuery(value: string) {
  return value.trim().toLowerCase();
}

export function matchesSettingsSearchTerms(query: string, terms: ReadonlyArray<string>) {
  const normalizedQuery = normalizeSettingsSearchQuery(query);
  if (!normalizedQuery) return true;

  const searchableText = terms.join(" ").toLowerCase();
  return normalizedQuery.split(/\s+/).every((term) => searchableText.includes(term));
}

export function getSettingsSearchResults(query: string) {
  if (!normalizeSettingsSearchQuery(query)) return [];

  return SETTINGS_SEARCH_ITEMS.filter((item) =>
    matchesSettingsSearchTerms(query, [item.label, item.section]),
  );
}
