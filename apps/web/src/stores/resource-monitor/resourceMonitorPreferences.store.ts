import { create } from "zustand";

export const RESOURCE_WIDGETS = ["cpu", "memory", "disk", "network", "temperature"] as const;
export type ResourceWidget = (typeof RESOURCE_WIDGETS)[number];

const STORAGE_KEY = "bigbud:resource-monitor-widgets:v1";
const DEFAULT_VISIBLE: readonly ResourceWidget[] = ["cpu", "memory", "disk", "network"];

export function readWidgetPreferences(value: unknown): ResourceWidget[] {
  if (!Array.isArray(value)) return [...DEFAULT_VISIBLE];
  return [
    ...new Set(
      value.filter(
        (item): item is ResourceWidget =>
          typeof item === "string" && RESOURCE_WIDGETS.includes(item as ResourceWidget),
      ),
    ),
  ];
}

function load(): ResourceWidget[] {
  if (typeof window === "undefined") return [...DEFAULT_VISIBLE];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? [...DEFAULT_VISIBLE] : readWidgetPreferences(JSON.parse(raw));
  } catch {
    return [...DEFAULT_VISIBLE];
  }
}

interface WidgetPreferences {
  visible: ResourceWidget[];
  toggle: (widget: ResourceWidget) => void;
}

export const useResourceWidgetPreferences = create<WidgetPreferences>((set) => ({
  visible: load(),
  toggle: (widget) =>
    set((state) => ({
      visible: state.visible.includes(widget)
        ? state.visible.filter((entry) => entry !== widget)
        : [...state.visible, widget],
    })),
}));

useResourceWidgetPreferences.subscribe((state) => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.visible));
  } catch {
    // Preferences remain usable when browser storage is unavailable.
  }
});
