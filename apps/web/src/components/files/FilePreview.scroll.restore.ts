/** Stop correcting after a bounded interval, even if a resource never finishes. */
export const MARKDOWN_RESTORE_TIMEOUT_MS = 10_000;

interface ObserveMarkdownRestoreInput {
  readonly container: HTMLDivElement;
  readonly root: HTMLElement;
  readonly restore: () => void;
  readonly publish: () => void;
  readonly invalidateLayout: () => void;
  readonly cancel: () => void;
}

/** Event-driven settling: stalled images cost no animation frames or geometry scans. */
export function observeMarkdownRestore({
  container,
  root,
  restore,
  publish,
  invalidateLayout,
  cancel,
}: ObserveMarkdownRestoreInput): () => void {
  let disposed = false;
  let correcting = true;
  let frame: number | null = null;
  const previousOverflowAnchor = container.style.overflowAnchor;
  container.style.overflowAnchor = "none";

  const changed = () => {
    if (disposed) return;
    if (!correcting) {
      invalidateLayout();
      return;
    }
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed) return;
      restore();
      publish();
    });
  };

  const resizeObserver = new ResizeObserver(changed);
  resizeObserver.observe(container);
  resizeObserver.observe(root);
  const mutationObserver = new MutationObserver(changed);
  mutationObserver.observe(root, {
    attributes: true,
    attributeFilter: ["class", "hidden", "src", "style"],
    childList: true,
    characterData: true,
    subtree: true,
  });
  const onKey = (event: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key))
      cancel();
  };
  container.addEventListener("wheel", cancel, { passive: true });
  container.addEventListener("touchstart", cancel, { passive: true });
  container.addEventListener("pointerdown", cancel);
  container.addEventListener("keydown", onKey);
  root.addEventListener("load", changed, true);
  root.addEventListener("error", changed, true);
  document.fonts?.addEventListener("loadingdone", changed);

  const deadline = setTimeout(() => {
    correcting = false;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    publish();
    // Keep only lightweight invalidation, so later toggles cannot reuse stale pixels.
  }, MARKDOWN_RESTORE_TIMEOUT_MS);

  return () => {
    disposed = true;
    clearTimeout(deadline);
    if (frame !== null) cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    container.removeEventListener("wheel", cancel);
    container.removeEventListener("touchstart", cancel);
    container.removeEventListener("pointerdown", cancel);
    container.removeEventListener("keydown", onKey);
    root.removeEventListener("load", changed, true);
    root.removeEventListener("error", changed, true);
    document.fonts?.removeEventListener("loadingdone", changed);
    container.style.overflowAnchor = previousOverflowAnchor;
  };
}
