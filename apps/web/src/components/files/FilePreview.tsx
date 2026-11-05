import { AlertCircleIcon } from "lucide-react";
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnnotationIntent } from "../../stores/composer";
import { selectElementContents, showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { FilePreviewCode } from "./FilePreview.code";
import { resolveMarkdownPreviewAnnotationSelection } from "./FilePreview.markdown.selection";
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
import { FilePreviewEditActions } from "./FilePreview.editActions";
import { FilePreviewEditRecovery } from "./FilePreview.editRecovery";
import { FilePreviewEditStatus } from "./FilePreview.editStatus";
import { useFileEditDraft } from "./useFileEditDraft";

const FilePreviewEditor = lazy(() =>
  import("./FilePreview.editor").then((module) => ({ default: module.FilePreviewEditor })),
);

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
  const [selectedRange, setSelectedRange] = useState<{
    startLine: number;
    endLine: number;
    renderedRange?: Range;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const editScrollRef = useRef<{ key: string; top: number } | null>(null);
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
  const { draftKey, draft, eligible } = useFileEditDraft({
    cwd,
    relativePath,
    executionTargetId,
    preview: state,
    editing,
    refreshPreview,
  });
  const fileKey = draftKey;
  useEffect(() => setEditing(false), [fileKey]);
  const contents = eligible && draft ? draft.contents : state.contents;
  const ready = (state.loaded && !state.error) || (eligible && draft !== null);
  const {
    viewMode: markdownViewMode,
    handleModeChange,
    handleScroll,
    cancelPendingRestore,
  } = useMarkdownPreviewScroll({
    fileKey,
    ready: ready && !editing,
    contents,
    isMarkdownFile,
    scrollContainerRef,
    linesContainerRef,
    markdownContentRef,
    lineHeight: FILE_PREVIEW_LINE_HEIGHT,
    totalLines: contents.split("\n").length,
    onScrollPositionChange,
  });

  useEffect(() => {
    setSelectedRange(null);
  }, [relativePath]);

  const { claimInitialPosition, handleSearchMatch } = useFilePreviewPosition({
    fileKey,
    contents,
    ready: ready && !editing,
    isMarkdownFile,
    mode: markdownViewMode,
    totalLines: contents.split("\n").length,
    targetLine,
    initialScrollTop,
    scrollContainerRef,
    linesContainerRef,
    markdownContentRef,
    cancelPendingRestore,
    onSearchMatch,
  });

  useEffect(() => {
    if (editing || editScrollRef.current?.key !== fileKey) return;
    const frame = requestAnimationFrame(() => {
      const prior = editScrollRef.current;
      if (prior?.key === fileKey && scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = prior.top;
        editScrollRef.current = null;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [editing, fileKey, markdownViewMode]);

  const lines = useMemo(
    () =>
      contents.split("\n").map((text, index) => ({
        id: `${index + 1}:${text}`,
        lineNumber: index + 1,
        text,
      })),
    [contents],
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
      let annotationRange: {
        startLine: number;
        endLine: number;
        renderedRange?: Range;
      } | null = null;

      if (onCreateAnnotation && selectedText.length >= 2 && contents) {
        if (isMarkdownFile && markdownViewMode === "preview") {
          annotationRange = resolveMarkdownPreviewAnnotationSelection(
            window.getSelection(),
            markdownContentRef.current,
          );
        } else {
          const startIndex = contents.indexOf(selectedText);
          if (startIndex !== -1) {
            const endIndex = startIndex + selectedText.length;
            annotationRange = {
              startLine: contents.slice(0, startIndex).split("\n").length,
              endLine: contents.slice(0, endIndex).split("\n").length,
            };
          }
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
    [absolutePath, isMarkdownFile, markdownViewMode, onCreateAnnotation, relativePath, contents],
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
      contents={contents}
      enabled={ready && !editing}
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
        leadingActions={
          <FilePreviewEditActions
            eligible={eligible}
            draft={draft}
            editing={editing}
            readUnavailable={state.error !== null || state.refreshError !== null}
            onToggle={() => {
              setSelectedRange(null);
              if (!editing)
                editScrollRef.current = {
                  key: fileKey,
                  top: scrollContainerRef.current?.scrollTop ?? 0,
                };
              setEditing((value) => !value);
            }}
          />
        }
        actions={
          <>
            <FilePreviewEditRecovery
              eligible={eligible}
              draft={draft}
              draftKey={draftKey}
              editing={editing}
              executionTargetId={executionTargetId}
              onRefresh={refreshPreview}
            />
            {isMarkdownFile && !editing ? (
              <FilePreviewMarkdownToggle
                viewMode={markdownViewMode}
                onViewModeChange={(mode) => {
                  if (mode === markdownViewMode) return;
                  if (ready) claimInitialPosition();
                  setSelectedRange(null);
                  handleModeChange(mode);
                }}
              />
            ) : null}
          </>
        }
      />

      <FilePreviewEditStatus
        draft={draft}
        eligible={eligible}
        readError={state.error ?? state.refreshError}
      />
      {shouldShowPreviewLoading(state) && !draft ? (
        <BigbudLoader className="min-h-0 flex-1" label="Loading file preview..." />
      ) : state.error && !draft ? (
        <div className="flex gap-2 p-3 text-sm text-destructive/80">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : editing && eligible && draft ? (
        <Suspense fallback={<BigbudLoader className="min-h-0 flex-1" label="Loading editor..." />}>
          <FilePreviewEditor
            key={draftKey}
            fileKey={draftKey}
            relativePath={relativePath}
            initialContents={draft.contents}
          />
        </Suspense>
      ) : isMarkdownFile && markdownViewMode === "preview" ? (
        <FilePreviewMarkdownView
          contents={contents}
          cwd={cwd}
          scrollContainerRef={scrollContainerRef}
          contentRef={markdownContentRef}
          selectedRange={selectedRange}
          renderedRange={selectedRange?.renderedRange}
          selectedText={selectedText}
          onContextMenu={handlePreviewContextMenu}
          onCreateAnnotation={onCreateAnnotation}
          onCancelAnnotation={() => setSelectedRange(null)}
          onScroll={handleScroll}
        />
      ) : (
        <FilePreviewCode
          contents={contents}
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
