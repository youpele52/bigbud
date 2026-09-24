import { THREAD_MAIN_CONTENT_MIN_WIDTH_PX } from "../layout/chatLayout.shared";

/** Selects the temporary game width only while its launched browser tab is visible. */
export function resolveRightPanelWidth(input: {
  normalWidth: number;
  gamesWidth: number;
  gamesTabId: string | null;
  activeTabId: string | null;
  rightPanelOpen: boolean;
}): number {
  return input.gamesTabId !== null && input.rightPanelOpen && input.gamesTabId === input.activeTabId
    ? input.gamesWidth
    : input.normalWidth;
}

/** Browser takes two thirds of content after the left sidebar; chat retains its minimum. */
export function resolveGamesPanelWidth(input: {
  viewportWidth: number;
  leftSidebarWidth: number;
  minimumBrowserWidth: number;
}): number {
  const available = Math.max(0, input.viewportWidth - input.leftSidebarWidth);
  return Math.max(
    input.minimumBrowserWidth,
    Math.min(
      Math.floor((available * 2) / 3),
      Math.max(input.minimumBrowserWidth, available - THREAD_MAIN_CONTENT_MIN_WIDTH_PX),
    ),
  );
}
