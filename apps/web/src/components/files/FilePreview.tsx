import { AlertCircleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnnotationIntent } from "../../stores/composer";
import { FilePreviewAnnotationComposer } from "./FilePreview.annotations";
import { selectElementContents, showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { FilePreviewHeader } from "./FilePreviewHeader";
import {
  FilePreviewMarkdownToggle,
  FilePreviewMarkdownView,
  type MarkdownFileViewMode,
} from "./FilePreview.markdown";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import {
  buildAbsolutePreviewPath,
  buildFilePreviewBreadcrumb,
  FILE_PREVIEW_LINE_HEIGHT,
  getPreviewScrollTop,
  inferPreviewLanguage,
  isMarkdownFilePath,
  shouldShowPreviewLoading,
} from "./FilePreview.logic";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";
import { usePreviewLoad } from "./usePreviewLoad";

interface FilePreviewProps {
  cwd: string;
  relativePath: string;
  targetLine?: number | undefined;
  executionTargetId?: string | undefined;
  projectName?: string | undefined;
  onBack?: (() => void) | undefined;
  onCreateAnnotation?: ((annotation: CodeAnnotationDraft) => void) | undefined;
}

export interface CodeAnnotationDraft {
  intent: AnnotationIntent;
  comment: string;
  startLine: number;
  endLine: number;
  text: string;
}

export const FilePreview = memo(function FilePreview({
  cwd,
  relativePath,
  targetLine,
  executionTargetId,
  projectName,
  onBack,
  onCreateAnnotation,
}: FilePreviewProps) {
  const [selectedRange, setSelectedRange] = useState<{ startLine: number; endLine: number } | null>(
    null,
  );
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownFileViewMode>("preview");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const linesContainerRef = useRef<HTMLDivElement>(null);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const { state, loadPreview, refreshPreview } = usePreviewLoad({
    cwd,
    relativePath,
    executionTargetId,
  });

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  useFilePreviewRefresh({
    cwd,
    relativePath,
    executionTargetId,
    refreshPreview,
  });

  useEffect(() => {
    setSelectedRange(null);
    setMarkdownViewMode("preview");
  }, [relativePath]);

  useEffect(() => {
    if (!targetLine || state.loading || state.error) {
      return;
    }

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const scrollTop = getPreviewScrollTop(
      targetLine,
      state.contents.split("\n").length,
      container.clientHeight,
      FILE_PREVIEW_LINE_HEIGHT,
    );
    if (scrollTop === null) {
      return;
    }
    container.scrollTo({ top: scrollTop, behavior: "smooth" });
  }, [state.contents, state.error, state.loading, targetLine]);

  const lines = useMemo(
    () =>
      state.contents.split("\n").map((text, index) => ({
        id: `${index + 1}:${text}`,
        lineNumber: index + 1,
        text,
      })),
    [state.contents],
  );
  const language = useMemo(() => inferPreviewLanguage(relativePath), [relativePath]);
  const isMarkdownFile = useMemo(() => isMarkdownFilePath(relativePath), [relativePath]);
  const breadcrumb = useMemo(
    () => buildFilePreviewBreadcrumb(projectName, cwd, relativePath),
    [cwd, projectName, relativePath],
  );
  const absolutePath = useMemo(
    () => buildAbsolutePreviewPath(cwd, relativePath),
    [cwd, relativePath],
  );
  const plainFallback = useMemo(
    () => (
      <pre className="m-0 p-0 font-mono text-xs leading-5 text-foreground/85">{state.contents}</pre>
    ),
    [state.contents],
  );
  const selectedText = useMemo(() => {
    if (!selectedRange) return "";
    return lines
      .slice(selectedRange.startLine - 1, selectedRange.endLine)
      .map((line) => line.text)
      .join("\n");
  }, [lines, selectedRange]);

  const selectLine = (lineNumber: number, extend: boolean) => {
    setSelectedRange((current) => {
      if (!extend || !current) {
        return { startLine: lineNumber, endLine: lineNumber };
      }
      return {
        startLine: Math.min(current.startLine, lineNumber),
        endLine: Math.max(current.endLine, lineNumber),
      };
    });
  };

  const handlePreviewContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const selectedText = window.getSelection()?.toString().trim() ?? "";
      let annotationRange: { startLine: number; endLine: number } | null = null;

      if (onCreateAnnotation && selectedText.length >= 2 && state.contents) {
        const startIndex = state.contents.indexOf(selectedText);
        if (startIndex !== -1) {
          const endIndex = startIndex + selectedText.length;
          annotationRange = {
            startLine: state.contents.slice(0, startIndex).split("\n").length,
            endLine: state.contents.slice(0, endIndex).split("\n").length,
          };
        }
      }

      event.preventDefault();
      event.stopPropagation();

      void showFilePreviewContextMenu({
        position: { x: event.clientX, y: event.clientY },
        absolutePath,
        relativePath,
        selectedText,
        canSelectAll: true,
        onSelectAll: () => {
          selectElementContents(codeContainerRef.current ?? scrollContainerRef.current);
        },
        onAnnotateSelection:
          annotationRange === null
            ? undefined
            : () => {
                setSelectedRange(annotationRange);
              },
      });
    },
    [absolutePath, onCreateAnnotation, relativePath, state.contents],
  );

  const handleHeaderContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      void showFilePreviewContextMenu({
        position: { x: event.clientX, y: event.clientY },
        absolutePath,
        relativePath,
        selectedText: "",
        canSelectAll: false,
      });
    },
    [absolutePath, relativePath],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <FilePreviewHeader
        breadcrumb={breadcrumb}
        onBack={onBack}
        onContextMenu={handleHeaderContextMenu}
        actions={
          isMarkdownFile ? (
            <FilePreviewMarkdownToggle
              viewMode={markdownViewMode}
              onViewModeChange={(mode) => {
                setSelectedRange(null);
                setMarkdownViewMode(mode);
              }}
            />
          ) : null
        }
      />

      {shouldShowPreviewLoading(state) ? (
        <div className="p-3 text-sm text-muted-foreground/70">Loading preview...</div>
      ) : state.error ? (
        <div className="flex gap-2 p-3 text-sm text-destructive/80">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : isMarkdownFile && markdownViewMode === "preview" ? (
        <FilePreviewMarkdownView
          contents={state.contents}
          cwd={cwd}
          scrollContainerRef={scrollContainerRef}
          linesContainerRef={linesContainerRef}
          selectedRange={selectedRange}
          selectedText={selectedText}
          onContextMenu={handlePreviewContextMenu}
          onCreateAnnotation={onCreateAnnotation}
          onCancelAnnotation={() => setSelectedRange(null)}
        />
      ) : (
        <div
          ref={scrollContainerRef}
          className="relative min-h-0 flex-1 overflow-auto"
          onContextMenu={handlePreviewContextMenu}
        >
          {state.truncated ? (
            <div className="border-b border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              Preview truncated.
            </div>
          ) : null}
          <div
            ref={linesContainerRef}
            className="flex w-max min-w-full select-text font-mono text-xs leading-5"
          >
            <div className="shrink-0 select-none border-r border-border/70">
              {lines.map((line) => (
                <button
                  key={line.id}
                  type="button"
                  className={
                    targetLine === line.lineNumber
                      ? "block h-5 w-10 cursor-pointer pr-2 text-right text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground bg-primary/15 text-foreground"
                      : selectedRange &&
                          line.lineNumber >= selectedRange.startLine &&
                          line.lineNumber <= selectedRange.endLine
                        ? "block h-5 w-10 cursor-pointer pr-2 text-right text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground bg-info/15 text-info"
                        : "block h-5 w-10 cursor-pointer pr-2 text-right text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground"
                  }
                  onClick={(event) => selectLine(line.lineNumber, event.shiftKey)}
                  title="Click to annotate this line. Shift-click to extend selection."
                >
                  {line.lineNumber}
                </button>
              ))}
            </div>
            <div
              ref={codeContainerRef}
              className="file-preview-code min-w-0 px-3 text-foreground/85"
            >
              <SyntaxHighlightedCode
                code={state.contents}
                language={language}
                themeName={themeName}
                fallback={plainFallback}
              />
            </div>
          </div>
          {selectedRange && onCreateAnnotation ? (
            <FilePreviewAnnotationComposer
              scrollContainerRef={scrollContainerRef}
              linesContainerRef={linesContainerRef}
              selectedRange={selectedRange}
              selectedText={selectedText}
              onCreateAnnotation={onCreateAnnotation}
              onCancel={() => setSelectedRange(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
});
