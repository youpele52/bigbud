import "../../index.css";

import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { FilePreviewCode } from "./FilePreview.code";
import { FILE_PREVIEW_LINE_HEIGHT } from "./FilePreview.logic";
import { FilePreviewMarkdownView } from "./FilePreview.markdown";
import {
  captureFilePreviewAnchor,
  measureMarkdownSourceBlocks,
  resolveFilePreviewScrollTop,
} from "./FilePreview.scroll.dom";
import type { MarkdownFileViewMode } from "./FilePreview.scroll.logic";

const BEFORE = Array.from({ length: 16 }, (_value, index) => `Paragraph ${index + 1}.\n`).join(
  "\n",
);
const AFTER = Array.from({ length: 16 }, (_value, index) => `Later paragraph ${index + 1}.\n`).join(
  "\n",
);

function createViewportRefs() {
  return {
    scrollContainerRef: createRef<HTMLDivElement>(),
    contentRef: createRef<HTMLDivElement>(),
    linesContainerRef: createRef<HTMLDivElement>(),
    codeContainerRef: createRef<HTMLDivElement>(),
  };
}

function Viewport({
  contents,
  mode,
  refs,
}: {
  contents: string;
  mode: MarkdownFileViewMode;
  refs: ReturnType<typeof createViewportRefs>;
}) {
  return (
    <div className="flex flex-col" style={{ width: 360, height: 220 }}>
      {mode === "preview" ? (
        <FilePreviewMarkdownView
          {...refs}
          contents={contents}
          cwd="/workspace"
          selectedRange={null}
          selectedText=""
          onContextMenu={() => undefined}
          onCancelAnnotation={() => undefined}
        />
      ) : (
        <FilePreviewCode
          {...refs}
          contents={contents}
          language="markdown"
          themeName="pierre-dark"
          isPlainTextFile
          truncated={false}
          selectedRange={null}
          selectedText=""
          onScroll={() => undefined}
          onContextMenu={() => undefined}
          onSelectRange={() => undefined}
          onSelectLine={() => undefined}
          onCancelAnnotation={() => undefined}
        />
      )}
    </div>
  );
}

function anchorInput(
  mode: MarkdownFileViewMode,
  refs: ReturnType<typeof createViewportRefs>,
  contents: string,
) {
  return {
    mode,
    container: refs.scrollContainerRef.current!,
    linesContainer: refs.linesContainerRef.current,
    markdownContent: refs.contentRef.current,
    lineHeight: FILE_PREVIEW_LINE_HEIGHT,
    totalLines: contents.split("\n").length,
  };
}

describe("FilePreview source block geometry", () => {
  it("keeps a code wrapper anchor when highlighting replaces its unmarked children", async () => {
    const container = createRef<HTMLDivElement>();
    const content = createRef<HTMLDivElement>();
    const mounted = await render(
      <div ref={container} style={{ height: 220, overflow: "auto" }}>
        <div ref={content}>
          <div style={{ height: 400 }} />
          <div data-source-start-line={21} data-source-end-line={26}>
            <div className="chat-markdown-shiki">
              <pre style={{ height: 160 }}>Highlighted code</pre>
            </div>
          </div>
          <div style={{ height: 400 }} />
        </div>
      </div>,
    );
    try {
      container.current!.scrollTop = 420;
      expect(container.current!.scrollTop).toBe(420);
      const blocks = measureMarkdownSourceBlocks(container.current!, content.current!);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ startLine: 21, endLine: 26, height: 160 });
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps wrapped parent text on its own source line when nested children follow", async () => {
    const parentLabel = "This long parent label stays distinct from its compact nested children. ";
    const contents = `${BEFORE}\n- **Parent** [label](README.md) ${parentLabel.repeat(10)}\n  - Child one\n  - Child two\n  - Child three\n\n${AFTER}`;
    const parentLine =
      contents.split("\n").findIndex((line) => line.startsWith("- **Parent**")) + 1;
    const refs = createViewportRefs();
    const mounted = await render(<Viewport contents={contents} mode="preview" refs={refs} />);

    try {
      const preview = refs.scrollContainerRef.current!;
      const content = refs.contentRef.current!;
      expect(preview.clientHeight).toBe(220);
      expect(preview.scrollHeight - preview.clientHeight).toBeGreaterThan(1000);
      const parent = content.querySelector<HTMLElement>(
        `li[data-source-start-line="${parentLine}"]`,
      )!;
      expect(parent.querySelector(":scope > p")).toBeNull();
      expect(JSON.parse(parent.dataset.sourceTextSegments!)).toEqual([[parentLine, parentLine]]);
      const ownText = measureMarkdownSourceBlocks(preview, content).find(
        (block) => block.startLine === parentLine && block.endLine === parentLine,
      )!;
      expect(ownText.height).toBeGreaterThan(220);
      preview.scrollTop = ownText.top + ownText.height * 0.7;
      expect(preview.scrollTop).toBeGreaterThan(300);

      const anchor = captureFilePreviewAnchor(anchorInput("preview", refs, contents));
      expect(anchor.sourceStartLine).toBe(parentLine);
      expect(anchor.sourceEndLine).toBe(parentLine);
      expect(Math.floor(anchor.sourceLine)).toBe(parentLine);

      await mounted.rerender(<Viewport contents={contents} mode="raw" refs={refs} />);
      const raw = refs.scrollContainerRef.current!;
      raw.scrollTop = resolveFilePreviewScrollTop({
        ...anchorInput("raw", refs, contents),
        anchor,
      })!;
      expect(raw.scrollHeight).toBeGreaterThan(raw.clientHeight);
      expect(raw.scrollTop).toBeGreaterThan(300);
      expect(captureFilePreviewAnchor(anchorInput("raw", refs, contents)).sourceStartLine).toBe(
        parentLine,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("uses whole table rows and preserves heading and code block boundaries", async () => {
    const contents = `${BEFORE}\n## Section boundary\n\n| Name | Details |\n| --- | --- |\n| Small | ${"Wrapped table cell content. ".repeat(15)} |\n| Next | Brief |\n\n\`\`\`text\nfirst line\nsecond line\n\`\`\`\n\n${AFTER}`;
    const refs = createViewportRefs();
    const mounted = await render(<Viewport contents={contents} mode="preview" refs={refs} />);

    try {
      const preview = refs.scrollContainerRef.current!;
      const content = refs.contentRef.current!;
      expect(preview.scrollHeight - preview.clientHeight).toBeGreaterThan(1000);
      const row = content.querySelector<HTMLElement>("tbody tr")!;
      const rowLine = Number(row.dataset.sourceStartLine);
      const rows = measureMarkdownSourceBlocks(preview, content).filter(
        (block) => block.startLine === rowLine && block.endLine === rowLine,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.height).toBe(row.getBoundingClientRect().height);
      expect(rows[0]!.height).toBeGreaterThan(100);
      preview.scrollTop = rows[0]!.top + rows[0]!.height * 0.7;
      expect(preview.scrollTop).toBeGreaterThan(300);
      expect(captureFilePreviewAnchor(anchorInput("preview", refs, contents)).sourceStartLine).toBe(
        rowLine,
      );

      for (const selector of ["h2", "pre"]) {
        const block = content.querySelector<HTMLElement>(selector)!;
        const top = block.getBoundingClientRect().top - preview.getBoundingClientRect().top;
        preview.scrollTop = Math.ceil(preview.scrollTop + top);
        const startLine = Number(block.dataset.sourceStartLine);
        const anchor = captureFilePreviewAnchor(anchorInput("preview", refs, contents));
        expect(anchor.sourceStartLine).toBe(startLine);
        const scrollTop = resolveFilePreviewScrollTop({
          ...anchorInput("preview", refs, contents),
          anchor,
        })!;
        expect(Math.abs(scrollTop - preview.scrollTop)).toBeLessThanOrEqual(2);
      }
    } finally {
      await mounted.unmount();
    }
  });
});
