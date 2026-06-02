import { AlertCircleIcon, XIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import type { AnnotationIntent } from "../../stores/composer";
import { AnnotationComposerPanel } from "../annotations/AnnotationComposerPanel";
import { Button } from "../ui/button";
import { readNativeApi } from "../../rpc/nativeApi";
import { cn } from "~/lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import { FILE_PREVIEW_LINE_HEIGHT, getPreviewScrollTop } from "./FilePreview.logic";

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
  contents: string;
  truncated: boolean;
  error: string | null;
}

const INITIAL_STATE: PreviewState = {
  loading: true,
  contents: "",
  truncated: false,
  error: null,
};

function fileNameFromPath(pathValue: string): string {
  const segments = pathValue.split("/");
  return segments.at(-1) ?? pathValue;
}

function inferPreviewLanguage(pathValue: string): string {
  const name = fileNameFromPath(pathValue).toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "text";
  if (extension === "cts" || extension === "mts") return "ts";
  if (extension === "mdx") return "md";
  if (extension === "yml") return "yaml";
  if (extension === "ps1") return "powershell";
  if (extension === "sh" || extension === "bash" || extension === "zsh") return "shellscript";
  return extension || "text";
}

function buildBreadcrumb(projectName: string | undefined, cwd: string, relativePath: string) {
  const rootName = projectName ?? fileNameFromPath(cwd);
  return [rootName, ...relativePath.split("/").filter(Boolean)].map((label, index, parts) => ({
    id: parts.slice(0, index + 1).join("/"),
    label,
  }));
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
  const [state, setState] = useState<PreviewState>(INITIAL_STATE);
  const [selectedRange, setSelectedRange] = useState<{ startLine: number; endLine: number } | null>(
    null,
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);

  useEffect(() => {
    let active = true;
    setState(INITIAL_STATE);

    const api = readNativeApi();
    if (!api) {
      setState({
        loading: false,
        contents: "",
        truncated: false,
        error: "Native API not found.",
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
        if (!active) return;
        setState({
          loading: false,
          contents: result.contents,
          truncated: result.truncated,
          error: null,
        });
      })
      .catch((error) => {
        if (!active) return;
        setState({
          loading: false,
          contents: "",
          truncated: false,
          error: error instanceof Error ? error.message : "Failed to load file preview.",
        });
      });

    return () => {
      active = false;
    };
  }, [cwd, executionTargetId, relativePath]);

  useEffect(() => {
    setSelectedRange(null);
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
  const breadcrumb = useMemo(
    () => buildBreadcrumb(projectName, cwd, relativePath),
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
        {onBack ? (
          <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Close">
            <XIcon />
          </Button>
        ) : null}
      </div>

      {state.loading ? (
        <div className="p-3 text-sm text-muted-foreground/70">Loading preview...</div>
      ) : state.error ? (
        <div className="flex gap-2 p-3 text-sm text-destructive/80">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : (
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          {state.truncated ? (
            <div className="border-b border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              Preview truncated.
            </div>
          ) : null}
          <div className="flex w-max min-w-full select-text font-mono text-xs leading-5">
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
            <div className="sticky bottom-3 mx-auto mt-3 w-[min(36rem,calc(100%-1.5rem))]">
              <AnnotationComposerPanel
                title="Code comment"
                targetLabel={
                  selectedRange.startLine === selectedRange.endLine
                    ? `Line ${selectedRange.startLine}`
                    : `Lines ${selectedRange.startLine}-${selectedRange.endLine}`
                }
                onCancel={() => setSelectedRange(null)}
                onSubmit={({ intent, comment }) => {
                  onCreateAnnotation({
                    intent,
                    comment,
                    startLine: selectedRange.startLine,
                    endLine: selectedRange.endLine,
                    text: selectedText,
                  });
                  setSelectedRange(null);
                }}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});
