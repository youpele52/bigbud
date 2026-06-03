import { create } from "zustand";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  getLeftSidebarGapWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
} from "../../components/layout/chatLayout.shared";

const RIGHT_PANEL_WIDTH_STORAGE_KEY = "right_panel_width";
const RIGHT_PANEL_MIN_WIDTH = 320;

export function getRightPanelMaxWidth(minWidth: number) {
  const sharedLayoutMaxWidth = Math.floor(
    window.innerWidth - getLeftSidebarGapWidth() - THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
  );

  return Math.max(minWidth, sharedLayoutMaxWidth);
}

function getRightPanelDefaultWidth(minWidth: number) {
  return Math.max(minWidth, Math.floor(window.innerWidth / 3));
}

function getInitialWidth(): number {
  const stored = getLocalStorageItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, Schema.Finite);
  const max = getRightPanelMaxWidth(RIGHT_PANEL_MIN_WIDTH);
  const defaultWidth = getRightPanelDefaultWidth(RIGHT_PANEL_MIN_WIDTH);
  return stored ? Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(max, stored)) : defaultWidth;
}

interface RightPanelWidthState {
  panelWidth: number;
  resizing: boolean;
  setPanelWidth: (width: number) => void;
  setResizing: (resizing: boolean) => void;
}

function clampAndSave(width: number): number {
  const max = getRightPanelMaxWidth(RIGHT_PANEL_MIN_WIDTH);
  const clamped = Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(max, width));
  setLocalStorageItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, clamped, Schema.Finite);
  return clamped;
}

export const useRightPanelWidthStore = create<RightPanelWidthState>((set) => ({
  panelWidth: getInitialWidth(),
  resizing: false,
  setPanelWidth: (panelWidth) => {
    const clamped = clampAndSave(panelWidth);
    set({ panelWidth: clamped });
  },
  setResizing: (resizing) => set({ resizing }),
}));

// Keep width in bounds when the viewport or left sidebar changes
window.addEventListener("resize", () => {
  const max = getRightPanelMaxWidth(RIGHT_PANEL_MIN_WIDTH);
  useRightPanelWidthStore.setState((state) => {
    if (state.panelWidth <= max) return state;
    const clamped = clampAndSave(max);
    return { panelWidth: clamped };
  });
});

const leftSidebarGap = document.querySelector<HTMLElement>(
  "[data-slot='sidebar'][data-side='left'] [data-slot='sidebar-gap']",
);

if (leftSidebarGap && typeof ResizeObserver !== "undefined") {
  const observer = new ResizeObserver(() => {
    const max = getRightPanelMaxWidth(RIGHT_PANEL_MIN_WIDTH);
    useRightPanelWidthStore.setState((state) => {
      if (state.panelWidth <= max) return state;
      const clamped = clampAndSave(max);
      return { panelWidth: clamped };
    });
  });
  observer.observe(leftSidebarGap);
}
