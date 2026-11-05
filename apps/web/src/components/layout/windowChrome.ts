/**
 * Desktop title bar geometry shared by the window-level sidebar toggle and page headers.
 *
 * The macOS traffic lights are native, so page zoom neither moves nor scales them; the desktop app
 * re-centres them in the zoomed 52px title bar (`apps/desktop/src/window/trafficLights.ts`). At
 * actual size the green button ends near x 76. Horizontal positions here are therefore written in
 * window points, divided by `--window-zoom`, so the toggle always keeps the same gap after the
 * buttons; sizes and vertical positions scale with the zoom like the rest of the title bar.
 */

/**
 * Fixed position of the 24px toggle, centred in the title bar. At 90pt its icon starts about 20pt
 * after the green button: 1.5 times the gap Claude's desktop app leaves.
 */
export const WINDOW_SIDEBAR_TOGGLE_POSITION_CLASS =
  "fixed top-[14px] left-[calc(90px/var(--window-zoom,1))] z-30";

/**
 * Leading spacer for page headers while the sidebar is closed. With the header's own padding and
 * gap it keeps titles 12px clear of the toggle.
 */
export const WINDOW_COLLAPSED_HEADER_INSET_CLASS = "w-[calc(90px/var(--window-zoom,1)_+_8px)]";
