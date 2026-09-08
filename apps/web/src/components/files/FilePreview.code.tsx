import type { DiffThemeName } from "../../lib/diffRendering";
import { AnnotationGutterTrigger } from "../annotations/AnnotationGutterTrigger";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import { FilePreviewAnnotationComposer } from "./FilePreview.annotations";
import { FILE_PREVIEW_LINE_HEIGHT } from "./FilePreview.logic";
import { resolveFilePreviewTextSelection } from "./FilePreview.selection";
import type { CodeAnnotationDraft } from "./FilePreview";
import { useRef, useState } from "react";

interface FilePreviewCodeProps {
  readonly contents: string;
  readonly language: string;
  readonly themeName: DiffThemeName;
  readonly isPlainTextFile: boolean;
  readonly truncated: boolean;
  readonly targetLine?: number | undefined;
  readonly selectedRange: { startLine: number; endLine: number } | null;
  readonly selectedText: string;
  readonly scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly linesContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly codeContainerRef: React.RefObject<HTMLDivElement | null>;
  readonly onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  readonly onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  readonly onSelectRange: (range: { startLine: number; endLine: number }) => void;
  readonly onSelectLine: (lineNumber: number, extend: boolean) => void;
  readonly onCreateAnnotation?: ((annotation: CodeAnnotationDraft) => void) | undefined;
  readonly onCancelAnnotation: () => void;
}

export function FilePreviewCode({
  contents,
  language,
  themeName,
  isPlainTextFile,
  truncated,
  targetLine,
  selectedRange,
  selectedText,
  scrollContainerRef,
  linesContainerRef,
  codeContainerRef,
  onScroll,
  onContextMenu,
  onSelectRange,
  onSelectLine,
  onCreateAnnotation,
  onCancelAnnotation,
}: FilePreviewCodeProps) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  const suppressClearClickRef = useRef(false);
  const lines = contents.split("\n");
  const plainFallback = (
    <pre className="m-0 p-0 font-mono text-xs leading-5 text-foreground/85">{contents}</pre>
  );

  return (
    <div
      ref={scrollContainerRef}
      className="relative min-h-0 flex-1 overflow-auto"
      onContextMenu={onContextMenu}
      onScroll={onScroll}
      onClickCapture={(event) => {
        const path = event.nativeEvent.composedPath();
        if (
          path.some(
            (target) =>
              target instanceof HTMLElement &&
              (target.hasAttribute("data-annotation-gutter-trigger") ||
                target.hasAttribute("data-annotation-composer")),
          )
        )
          return;
        if (suppressClearClickRef.current) {
          suppressClearClickRef.current = false;
          return;
        }
        onCancelAnnotation();
      }}
    >
      {truncated ? (
        <div className="border-b border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          Preview truncated.
        </div>
      ) : null}
      <div
        ref={linesContainerRef}
        className="flex w-max min-w-full select-text font-mono text-xs leading-5"
        onPointerMove={(event) => {
          if (!onCreateAnnotation) return;
          const line =
            Math.floor(
              (event.clientY - event.currentTarget.getBoundingClientRect().top) /
                FILE_PREVIEW_LINE_HEIGHT,
            ) + 1;
          setHoveredLine(line >= 1 && line <= lines.length ? line : null);
        }}
        onPointerLeave={() => setHoveredLine(null)}
        onMouseUp={(event) => {
          if (event.button !== 0 || !onCreateAnnotation) return;
          const selection = resolveFilePreviewTextSelection(
            window.getSelection(),
            codeContainerRef.current,
          );
          if (selection) {
            suppressClearClickRef.current = true;
            onSelectRange({ startLine: selection.startLine, endLine: selection.endLine });
          }
        }}
      >
        <div className="shrink-0 select-none border-r border-border/70">
          {lines.map((text, index) => {
            const lineNumber = index + 1;
            const selected =
              selectedRange &&
              lineNumber >= selectedRange.startLine &&
              lineNumber <= selectedRange.endLine;
            const active = selectedRange?.endLine === lineNumber;
            return (
              <AnnotationGutterTrigger
                key={`${lineNumber}:${text}`}
                ariaLabel={
                  onCreateAnnotation ? `Annotate line ${lineNumber}` : `Select line ${lineNumber}`
                }
                fallback={lineNumber}
                showIcon={Boolean(onCreateAnnotation && (hoveredLine === lineNumber || active))}
                showIconOnFocus={false}
                active={Boolean(onCreateAnnotation && active)}
                className={
                  targetLine === lineNumber
                    ? "w-10 bg-primary/15 text-foreground"
                    : selected
                      ? "w-10 bg-info/15"
                      : "w-10"
                }
                onClick={(event) => onSelectLine(lineNumber, event.shiftKey)}
              />
            );
          })}
        </div>
        <div ref={codeContainerRef} className="file-preview-code min-w-0 px-3 text-foreground/85">
          {isPlainTextFile ? (
            plainFallback
          ) : (
            <SyntaxHighlightedCode
              code={contents}
              language={language}
              themeName={themeName}
              fallback={plainFallback}
            />
          )}
        </div>
      </div>
      {selectedRange && onCreateAnnotation ? (
        <FilePreviewAnnotationComposer
          scrollContainerRef={scrollContainerRef}
          linesContainerRef={linesContainerRef}
          selectedRange={selectedRange}
          selectedText={selectedText}
          onCreateAnnotation={onCreateAnnotation}
          onCancel={onCancelAnnotation}
        />
      ) : null}
    </div>
  );
}
