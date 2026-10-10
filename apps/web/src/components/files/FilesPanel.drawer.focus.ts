/** Focuses an already-visible row or the main header toggle without changing tree scroll. */
export function focusFilesTreeDrawer(
  drawer: HTMLDivElement,
  lastFocusedRow: HTMLButtonElement | null,
  headerToggle: HTMLButtonElement | null,
) {
  const scroll = drawer.querySelector<HTMLDivElement>("[data-files-tree-scroll]");
  if (!scroll || drawer.inert) return;
  const bounds = scroll.getBoundingClientRect();
  const visibleTop = bounds.top + scroll.clientTop;
  const visibleBottom = visibleTop + scroll.clientHeight;
  const selected = scroll.querySelector<HTMLButtonElement>('button[aria-current="page"]');
  for (const candidate of [selected, lastFocusedRow]) {
    if (!candidate || !scroll.contains(candidate) || candidate.disabled) continue;
    const row = candidate.getBoundingClientRect();
    if (row.height > 0 && row.top >= visibleTop && row.bottom <= visibleBottom) {
      candidate.focus({ preventScroll: true });
      return;
    }
  }
  headerToggle?.focus({ preventScroll: true });
}
