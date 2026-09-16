import { AlertCircleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnnotationIntent } from "../../stores/composer";
import { selectElementContents, showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { FilePreviewCode } from "./FilePreview.code";
import { FilePreviewHeader } from "./FilePreviewHeader";
import { FilePreviewMarkdownToggle, FilePreviewMarkdownView } from "./FilePreview.markdown";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import {
  buildAbsolutePreviewPath,
  buildFilePreviewBreadcrumb,
  FILE_PREVIEW_LINE_HEIGHT,
  inferPreviewLanguage,
  isMarkdownFilePath,
  shouldShowPreviewLoading,
  shouldSyntaxHighlightPreviewPath,
} from "./FilePreview.logic";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";
import { usePreviewLoad } from "./usePreviewLoad";
import type { FilePreviewNavigationProps, FilePreviewScrollProps } from "./FilePreview.types";
import { useFilePreviewPosition } from "./useFilePreviewPosition";
import { useMarkdownPreviewScroll } from "./useMarkdownPreviewScroll";
import { FilePreviewSearchFocus } from "./FilePreviewSearchFocus";
import { BigbudLoader } from "../layout/BigbudLoader";

interface FilePreviewProps extends FilePreviewNavigationProps, FilePreviewScrollProps {
  cwd: string;
  relativePath: string;
  targetLine?: number | undefined;
  executionTargetId?: string | undefined;
  projectName?: string | undefined;
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
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
  onClose,
  initialScrollTop,
  onScrollPositionChange,
  onPreviewLoadError,
  onCreateAnnotation,
  onSearchMatch,
}: FilePreviewProps) {
  const [selectedRange, setSelectedRange] = useState<{ startLine: number; endLine: number } | null>(
    null,
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const linesContainerRef = useRef<HTMLDivElement>(null);
  const markdownContentRef = useRef<HTMLDivElement>(null);
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const { state, loadPreview, refreshPreview } = usePreviewLoad({
    cwd,
    relativePath,
    executionTargetId,
    onLoadError: onPreviewLoadError,
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

  const isMarkdownFile = useMemo(() => isMarkdownFilePath(relativePath), [relativePath]);
  const fileKey = JSON.stringify([executionTargetId ?? null, cwd, relativePath]);
  const ready = state.loaded && !state.error;
  const {
    viewMode: markdownViewMode,
    handleModeChange,
    handleScroll,
    cancelPendingRestore,
  } = useMarkdownPreviewScroll({
    fileKey,
    ready,
    contents: state.contents,
    isMarkdownFile,
    scrollContainerRef,
    linesContainerRef,
    markdownContentRef,
    lineHeight: FILE_PREVIEW_LINE_HEIGHT,
    totalLines: state.contents.split("\n").length,
    onScrollPositionChange,
  });

  useEffect(() => {
    setSelectedRange(null);
  }, [relativePath]);

  const { claimInitialPosition, handleSearchMatch } = useFilePreviewPosition({
    fileKey,
    contents: state.contents,
    ready,
    isMarkdownFile,
    mode: markdownViewMode,
    totalLines: state.contents.split("\n").length,
    targetLine,
    initialScrollTop,
    scrollContainerRef,
    linesContainerRef,
    markdownContentRef,
    cancelPendingRestore,
    onSearchMatch,
  });

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
  const isPlainTextFile = useMemo(
    () => !isMarkdownFile && !shouldSyntaxHighlightPreviewPath(relativePath),
    [isMarkdownFile, relativePath],
  );
  const breadcrumb = useMemo(
    () => buildFilePreviewBreadcrumb(projectName, cwd, relativePath),
    [cwd, projectName, relativePath],
  );
  const absolutePath = useMemo(
    () => buildAbsolutePreviewPath(cwd, relativePath),
    [cwd, relativePath],
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
    <FilePreviewSearchFocus
      className="flex h-full min-h-0 flex-col bg-background"
      contents={state.contents}
      enabled={state.loaded && !state.loading && !state.error}
      path={relativePath}
      onSelectMatch={handleSearchMatch}
    >
      <FilePreviewHeader
        breadcrumb={breadcrumb}
        absolutePath={absolutePath}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onNavigateBack={onNavigateBack}
        onNavigateForward={onNavigateForward}
        onClose={onClose}
        onContextMenu={handleHeaderContextMenu}
        actions={
          isMarkdownFile ? (
            <FilePreviewMarkdownToggle
              viewMode={markdownViewMode}
              onViewModeChange={(mode) => {
                if (mode === markdownViewMode) return;
                if (ready) claimInitialPosition();
                setSelectedRange(null);
                handleModeChange(mode);
              }}
            />
          ) : null
        }
      />

      {shouldShowPreviewLoading(state) ? (
        <BigbudLoader className="min-h-0 flex-1" label="Loading file preview..." />
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
          contentRef={markdownContentRef}
          linesContainerRef={linesContainerRef}
          selectedRange={selectedRange}
          selectedText={selectedText}
          onContextMenu={handlePreviewContextMenu}
          onCreateAnnotation={onCreateAnnotation}
          onCancelAnnotation={() => setSelectedRange(null)}
          onScroll={handleScroll}
        />
      ) : (
        <FilePreviewCode
          contents={state.contents}
          language={language}
          themeName={themeName}
          isPlainTextFile={isPlainTextFile}
          truncated={state.truncated}
          targetLine={targetLine}
          selectedRange={selectedRange}
          selectedText={selectedText}
          scrollContainerRef={scrollContainerRef}
          linesContainerRef={linesContainerRef}
          codeContainerRef={codeContainerRef}
          onScroll={handleScroll}
          onContextMenu={handlePreviewContextMenu}
          onSelectRange={setSelectedRange}
          onSelectLine={selectLine}
          onCreateAnnotation={onCreateAnnotation}
          onCancelAnnotation={() => setSelectedRange(null)}
        />
      )}
    </FilePreviewSearchFocus>
  );
});
