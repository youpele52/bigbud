import { useCallback, useState } from "react";

const GIT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "bigbud:git-panel-sidebar-width:v1";
const GIT_PANEL_SIDEBAR_DEFAULT_WIDTH = 240;
const GIT_PANEL_SIDEBAR_MIN_WIDTH = 180;
const GIT_PANEL_SIDEBAR_MAX_WIDTH_FACTOR = 0.6;

export function useGitPanelSidebarWidth() {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number.parseInt(
      localStorage.getItem(GIT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY) ?? "",
      10,
    );
    return Number.isFinite(stored) && stored >= GIT_PANEL_SIDEBAR_MIN_WIDTH
      ? stored
      : GIT_PANEL_SIDEBAR_DEFAULT_WIDTH;
  });

  const resizeSidebarWidth = useCallback(
    (containerWidth: number, startWidth: number, deltaX: number) => {
      const maxWidth = containerWidth * GIT_PANEL_SIDEBAR_MAX_WIDTH_FACTOR;
      const nextWidth = Math.max(
        GIT_PANEL_SIDEBAR_MIN_WIDTH,
        Math.min(maxWidth, startWidth + deltaX),
      );
      setSidebarWidth(nextWidth);
      localStorage.setItem(GIT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    },
    [],
  );

  return { sidebarWidth, resizeSidebarWidth };
}
