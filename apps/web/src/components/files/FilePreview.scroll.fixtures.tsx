import "../../index.css";

import { createRef } from "react";
import { expect, vi } from "vitest";
import { FilePreviewCode } from "./FilePreview.code";
import { FilePreviewMarkdownToggle, FilePreviewMarkdownView } from "./FilePreview.markdown";
import { captureFilePreviewAnchor } from "./FilePreview.scroll.dom";
import type { MarkdownFileViewMode } from "./FilePreview.scroll.logic";
import { useMarkdownPreviewScroll } from "./useMarkdownPreviewScroll";

export const SCROLL_CONTENTS = Array.from(
  { length: 36 },
  (_, index) =>
    `## Release ${index + 1}\n\nA changelog entry with enough text to wrap in the preview.`,
).join("\n\n");

export function createScrollRefs() {
  return {
    container: createRef<HTMLDivElement>(),
    lines: createRef<HTMLDivElement>(),
    markdown: createRef<HTMLDivElement>(),
    code: createRef<HTMLDivElement>(),
  };
}
export type ScrollRefs = ReturnType<typeof createScrollRefs>;

export function ScrollHarness({
  refs,
  contents = SCROLL_CONTENTS,
  fileKey = "local:/workspace:CHANGELOG.md",
  onPosition,
  plainText = true,
  truncated = false,
  width = 480,
  ready = true,
}: {
  refs: ScrollRefs;
  contents?: string;
  fileKey?: string;
  onPosition?: ((scrollTop: number) => void) | undefined;
  plainText?: boolean;
  truncated?: boolean;
  width?: number;
  ready?: boolean;
}) {
  const { viewMode, handleModeChange, handleScroll } = useMarkdownPreviewScroll({
    fileKey,
    contents,
    ready,
    isMarkdownFile: true,
    scrollContainerRef: refs.container,
    linesContainerRef: refs.lines,
    markdownContentRef: refs.markdown,
    lineHeight: 20,
    totalLines: contents.split("\n").length,
    onScrollPositionChange: onPosition,
  });
  return (
    <div data-testid="scroll-harness" style={{ width, height: 260 }} className="flex flex-col">
      <FilePreviewMarkdownToggle viewMode={viewMode} onViewModeChange={handleModeChange} />
      <div className="flex min-h-0 flex-1 flex-col">
        {!ready ? (
          <div>Loading</div>
        ) : viewMode === "preview" ? (
          <FilePreviewMarkdownView
            contents={contents}
            cwd="/workspace"
            scrollContainerRef={refs.container}
            contentRef={refs.markdown}
            linesContainerRef={refs.lines}
            selectedRange={null}
            selectedText=""
            onContextMenu={() => undefined}
            onCancelAnnotation={() => undefined}
            onScroll={handleScroll}
          />
        ) : (
          <FilePreviewCode
            contents={contents}
            language="markdown"
            themeName="pierre-dark"
            isPlainTextFile={plainText}
            truncated={truncated}
            selectedRange={null}
            selectedText=""
            scrollContainerRef={refs.container}
            linesContainerRef={refs.lines}
            codeContainerRef={refs.code}
            onScroll={handleScroll}
            onContextMenu={() => undefined}
            onSelectRange={() => undefined}
            onSelectLine={() => undefined}
            onCancelAnnotation={() => undefined}
          />
        )}
      </div>
      <output data-testid="view-mode">{viewMode}</output>
    </div>
  );
}

export function readingAnchor(refs: ScrollRefs, contents = SCROLL_CONTENTS) {
  return captureFilePreviewAnchor({
    mode: refs.markdown.current ? "preview" : "raw",
    container: refs.container.current!,
    linesContainer: refs.lines.current,
    markdownContent: refs.markdown.current,
    lineHeight: 20,
    totalLines: contents.split("\n").length,
  });
}

export async function changeMode(mode: MarkdownFileViewMode) {
  document
    .querySelector<HTMLButtonElement>(
      `[aria-label="View ${mode === "raw" ? "raw markdown" : "markdown preview"}"]`,
    )!
    .click();
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="view-mode"]')?.textContent).toBe(mode),
  );
  await animationFrames();
}

export async function animationFrames() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

export async function readerScroll(refs: ScrollRefs, top: number) {
  const container = refs.container.current!;
  expect(container.scrollHeight - container.clientHeight).toBeGreaterThan(100);
  container.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  container.scrollTop = top;
  container.dispatchEvent(new Event("scroll"));
  if (top > 0) expect(container.scrollTop).toBeGreaterThan(0);
  await animationFrames();
}
