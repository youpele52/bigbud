import { create } from "zustand";

export const RESOURCE_DETAILS = [
  "ipAddress",
  "hostDetails",
  "hostExtras",
  "disks",
  "interfaces",
  "cores",
  "memory",
  "temperatures",
  "processes",
] as const;
export type ResourceDetail = (typeof RESOURCE_DETAILS)[number];

const STORAGE_KEY = "bigbud:resource-monitor-details:v3";
const LEGACY_V2_STORAGE_KEY = "bigbud:resource-monitor-details:v2";
const LEGACY_V1_STORAGE_KEY = "bigbud:resource-monitor-details:v1";
const DEFAULT_VISIBLE: readonly ResourceDetail[] = [
  "ipAddress",
  "hostDetails",
  "hostExtras",
  "disks",
  "interfaces",
  "cores",
  "memory",
  "processes",
];

export function readDetailPreferences(value: unknown): ResourceDetail[] {
  if (!Array.isArray(value)) return [...DEFAULT_VISIBLE];
  return [
    ...new Set(
      value.filter(
        (item): item is ResourceDetail =>
          typeof item === "string" && RESOURCE_DETAILS.includes(item as ResourceDetail),
      ),
    ),
  ];
}

export function parseDetailPreferences(raw: string | null): ResourceDetail[] {
  if (raw === null) return [...DEFAULT_VISIBLE];
  try {
    return readDetailPreferences(JSON.parse(raw));
  } catch {
    return [...DEFAULT_VISIBLE];
  }
}

export function migrateLegacyDetailPreferences(raw: string | null): ResourceDetail[] {
  const details: ResourceDetail[] = ["ipAddress", "hostDetails", ...parseDetailPreferences(raw)];
  return [...new Set(details)];
}

export function migrateV2DetailPreferences(raw: string | null): ResourceDetail[] {
  const details: ResourceDetail[] = ["hostDetails", ...parseDetailPreferences(raw)];
  return [...new Set(details)];
}

function persistMigratedPreferences(details: ResourceDetail[]): ResourceDetail[] {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(details));
  } catch {
    // Keep migrated preferences available in memory when storage is unavailable.
  }
  return details;
}

function load(): ResourceDetail[] {
  if (typeof window === "undefined") return [...DEFAULT_VISIBLE];
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return parseDetailPreferences(stored);

    const legacyV2 = window.localStorage.getItem(LEGACY_V2_STORAGE_KEY);
    if (legacyV2 !== null) return persistMigratedPreferences(migrateV2DetailPreferences(legacyV2));

    const legacyV1 = window.localStorage.getItem(LEGACY_V1_STORAGE_KEY);
    if (legacyV1 !== null)
      return persistMigratedPreferences(migrateLegacyDetailPreferences(legacyV1));

    return [...DEFAULT_VISIBLE];
  } catch {
    return [...DEFAULT_VISIBLE];
  }
}

interface DetailPreferences {
  visible: ResourceDetail[];
  toggle: (detail: ResourceDetail) => void;
}

export const useResourceDetailPreferences = create<DetailPreferences>((set) => ({
  visible: load(),
  toggle: (detail) =>
    set((state) => ({
      visible: state.visible.includes(detail)
        ? state.visible.filter((entry) => entry !== detail)
        : [...state.visible, detail],
    })),
}));

useResourceDetailPreferences.subscribe((state) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visible));
  } catch {
    // Preferences remain usable when browser storage is unavailable.
  }
});
