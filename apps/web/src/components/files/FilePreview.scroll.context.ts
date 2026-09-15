import type { MarkdownFileViewMode, ReadingAnchor } from "./FilePreview.scroll.logic";

export interface ModeScrollSnapshot {
  readonly scrollTop: number;
  readonly layout: string;
}

export interface MarkdownReadingContext {
  readonly anchor: ReadingAnchor;
  readonly snapshots: Partial<Record<MarkdownFileViewMode, ModeScrollSnapshot>>;
}

/** Read only at a handoff or after layout changes, never on ordinary scrolling. */
export function measureFilePreviewLayout(
  container: HTMLDivElement,
  root: HTMLElement | null,
): string {
  const rect = root?.getBoundingClientRect();
  const viewportTop = container.getBoundingClientRect().top;
  const blocks = root?.querySelectorAll<HTMLElement>("[data-source-start-line]");
  const positions = blocks
    ? Array.from(blocks, (block) => {
        const bounds = block.getBoundingClientRect();
        return `${block.dataset.sourceStartLine}:${block.dataset.sourceEndLine}:${Math.round((bounds.top - viewportTop + container.scrollTop) * 10)}:${Math.round(bounds.height * 10)}`;
      }).join(";")
    : "";
  return [
    container.clientWidth,
    container.clientHeight,
    container.scrollWidth,
    container.scrollHeight,
    rect?.width,
    rect?.height,
    positions,
  ].join("|");
}
