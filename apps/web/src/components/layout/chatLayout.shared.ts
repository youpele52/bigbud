export const THREAD_MAIN_CONTENT_MIN_WIDTH_PX = 40 * 16;

const LEFT_SIDEBAR_GAP_SELECTOR =
  "[data-slot='sidebar'][data-side='left'] [data-slot='sidebar-gap']";
const RIGHT_PANEL_PLACEHOLDER_SELECTOR = "[data-right-panel-placeholder='true']";

function readElementWidth(selector: string): number {
  if (typeof document === "undefined") {
    return 0;
  }

  return document.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
}

export function getLeftSidebarGapWidth(): number {
  return readElementWidth(LEFT_SIDEBAR_GAP_SELECTOR);
}

export function getBrowserPanelPlaceholderWidth(): number {
  return readElementWidth(RIGHT_PANEL_PLACEHOLDER_SELECTOR);
}
