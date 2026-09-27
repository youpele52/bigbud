import { create } from "zustand";

export const RESOURCE_DETAILS = [
  "hostExtras",
  "disks",
  "interfaces",
  "cores",
  "memory",
  "temperatures",
  "processes",
] as const;
export type ResourceDetail = (typeof RESOURCE_DETAILS)[number];

const STORAGE_KEY = "bigbud:resource-monitor-details:v1";
const DEFAULT_VISIBLE: readonly ResourceDetail[] = [
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

function load(): ResourceDetail[] {
  if (typeof window === "undefined") return [...DEFAULT_VISIBLE];
  try {
    return parseDetailPreferences(window.localStorage.getItem(STORAGE_KEY));
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
