import { AlertCircleIcon, XIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnnotationIntent } from "../../stores/composer";
import { Button } from "../ui/button";
import { FilePreviewAnnotationComposer } from "./FilePreview.annotations";
import {
  FilePreviewMarkdownToggle,
  FilePreviewMarkdownView,
  type MarkdownFileViewMode,
} from "./FilePreview.markdown";
import { readNativeApi } from "../../rpc/nativeApi";
import { cn } from "~/lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import {
  buildFilePreviewBreadcrumb,
  FILE_PREVIEW_LINE_HEIGHT,
  getPreviewScrollTop,
  inferPreviewLanguage,
  isMarkdownFilePath,
  shouldShowPreviewLoading,
} from "./FilePreview.logic";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";

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

interface PreviewState {
  loading: boolean;
  loaded: boolean;
  contents: string;
  truncated: boolean;
  error: string | null;
}

const INITIAL_STATE: PreviewState = {
  loading: true,
  loaded: false,
  contents: "",
  truncated: false,
  error: null,
};

export const FilePreview = memo(function FilePreview({
  cwd,
  relativePath,
  targetLine,
  executionTargetId,
  projectName,
  onBack,
  onCreateAnnotation,
}: FilePreviewProps) {
  const [state, setState] = useState<PreviewState>(INITIAL_STATE);
  const [selectedRange, setSelectedRange] = useState<{ startLine: number; endLine: number } | null>(
    null,
  );
  const [markdownViewMode, setMarkdownViewMode] = useState<MarkdownFileViewMode>("preview");
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const linesContainerRef = useRef<HTMLDivElement>(null);
  const previewRequestIdRef = useRef(0);
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);

  const loadPreview = useCallback(
    (options?: { readonly preserveContents?: boolean }) => {
      const requestId = ++previewRequestIdRef.current;
      const preserveContents = options?.preserveContents ?? false;

      setState((current) =>
        preserveContents
          ? {
              ...current,
              loading: true,
            }
          : INITIAL_STATE,
      );

      const api = readNativeApi();
      if (!api) {
        setState((current) => {
          if (requestId !== previewRequestIdRef.current) {
            return current;
          }

          if (preserveContents && current.loaded) {
            return {
              ...current,
              loading: false,
            };
          }

          return {
            loading: false,
            loaded: false,
            contents: "",
            truncated: false,
            error: "Native API not found.",
          };
        });
        return;
      }

      void api.projects
        .readFilePreview({
          cwd,
          relativePath,
          ...(executionTargetId ? { executionTargetId } : {}),
        })
        .then((result) => {
          setState((current) => {
            if (requestId !== previewRequestIdRef.current) {
              return current;
            }

            return {
              loading: false,
              loaded: true,
              contents: result.contents,
              truncated: result.truncated,
              error: null,
            };
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Failed to load file preview.";

          setState((current) => {
            if (requestId !== previewRequestIdRef.current) {
              return current;
            }

            if (preserveContents && current.loaded) {
              return {
                ...current,
                loading: false,
              };
            }

            return {
              loading: false,
              loaded: false,
              contents: "",
              truncated: false,
              error: message,
            };
          });
        });
    },
    [cwd, executionTargetId, relativePath],
  );

  const refreshPreview = useCallback(() => {
    loadPreview({ preserveContents: true });
  }, [loadPreview]);

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

  const handleCodeContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onCreateAnnotation) return;

    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();
    if (!selectedText || selectedText.length < 2 || !state.contents) {
      return;
    }

    const startIndex = state.contents.indexOf(selectedText);
    if (startIndex === -1) return;

    const api = readNativeApi();
    if (!api?.contextMenu) return;

    const endIndex = startIndex + selectedText.length;
    const startLine = state.contents.slice(0, startIndex).split("\n").length;
    const endLine = state.contents.slice(0, endIndex).split("\n").length;

    event.preventDefault();
    event.stopPropagation();

    void api.contextMenu
      .show([{ id: "annotate-selection", label: "Annotate selection" }], {
        x: event.clientX,
        y: event.clientY,
      })
      .then((action) => {
        if (action === "annotate-selection") {
          setSelectedRange({ startLine, endLine });
        }
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-2 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs">
            {breadcrumb.map((part, index) => (
              <span key={part.id} className="flex min-w-0 items-center gap-1">
                {index > 0 ? <span className="text-muted-foreground/45">&gt;</span> : null}
                <span
                  className={cn(
                    "truncate",
                    index === breadcrumb.length - 1
                      ? "font-medium text-foreground"
                      : "text-muted-foreground/75",
                  )}
                  title={part.label}
                >
                  {part.label}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-8">
          {isMarkdownFile ? (
            <FilePreviewMarkdownToggle
              viewMode={markdownViewMode}
              onViewModeChange={(mode) => {
                setSelectedRange(null);
                setMarkdownViewMode(mode);
              }}
            />
          ) : null}
          {onBack ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onBack}
              aria-label="Close"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      </div>

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
          onContextMenu={handleCodeContextMenu}
          onCreateAnnotation={onCreateAnnotation}
          onCancelAnnotation={() => setSelectedRange(null)}
        />
      ) : (
        <div ref={scrollContainerRef} className="relative min-h-0 flex-1 overflow-auto">
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
                  className={cn(
                    "block h-5 w-10 cursor-pointer pr-2 text-right text-muted-foreground/55 hover:bg-accent/40 hover:text-foreground",
                    targetLine === line.lineNumber && "bg-primary/15 text-foreground",
                    selectedRange &&
                      line.lineNumber >= selectedRange.startLine &&
                      line.lineNumber <= selectedRange.endLine &&
                      "bg-info/15 text-info",
                  )}
                  onClick={(event) => selectLine(line.lineNumber, event.shiftKey)}
                  title="Click to annotate this line. Shift-click to extend selection."
                >
                  {line.lineNumber}
                </button>
              ))}
            </div>
            <div
              className="file-preview-code min-w-0 px-3 text-foreground/85"
              onContextMenu={handleCodeContextMenu}
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
