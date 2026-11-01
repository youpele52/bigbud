/** Shared conversation column: timeline rows, live activity cards, and banners align to it. */
export const CHAT_COLUMN_CLASS_NAME = "mx-auto w-full min-w-0 max-w-3xl";

/**
 * Desktop chat header grid while the sidebar is closed: the title starts on the conversation
 * column's left edge. The timeline centres a 48rem column (`CHAT_COLUMN_CLASS_NAME`) inside 20px
 * padding plus a 6px scrollbar gutter; the header has the same 20px padding and an 8px column gap,
 * hence `(100% - 48rem - 6px) / 2 - 8px`. The leading column never shrinks below the window
 * sidebar toggle's clearance (`components/layout/windowChrome.ts`), so on a narrow window the
 * title sits after the toggle instead.
 */
export const CHAT_COLUMN_HEADER_TITLE_GRID_CLASS =
  "grid min-w-0 flex-1 grid-cols-[max(calc(90px/var(--window-zoom,1)_+_16px),calc((100%_-_48rem_-_6px)/2_-_8px))_minmax(0,1fr)_max-content] items-center gap-2";
