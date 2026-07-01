import { AlertCircleIcon } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { BaseMarkdown } from "~/components/common/BaseMarkdown";
import { SyntaxHighlightedCode } from "../chat/common/SyntaxHighlightedCode";
import { selectElementContents, showFilePreviewContextMenu } from "./FilePreview.contextMenu";
import { FilePreviewHeader } from "./FilePreviewHeader";
import {
  buildAbsolutePreviewPath,
  buildFilePreviewBreadcrumb,
  shouldShowPreviewLoading,
} from "./FilePreview.logic";
import { type CodeAnnotationDraft } from "./FilePreview";
import {
  cellSource,
  detectNotebookLanguage,
  getNotebookFlatSource,
  parseNotebook,
  renderOutput,
  type OutputRendering,
} from "./IpynbPreview.logic";
import { OutputArea } from "./IpynbPreview.render";
import { NotebookAnnotationComposer } from "./IpynbPreview.annotations";
import { useFilePreviewRefresh } from "./useFilePreviewRefresh";
import { usePreviewLoad } from "./usePreviewLoad";

interface IpynbPreviewProps {
  cwd: string;
  relativePath: string;
  targetLine?: number | undefined;
  executionTargetId?: string | undefined;
  projectName?: string | undefined;
  onBack?: (() => void) | undefined;
  onCreateAnnotation?: ((annotation: CodeAnnotationDraft) => void) | undefined;
}

interface LineRange {
  startLine: number;
  endLine: number;
}

function notebookSizerCellKey(source: string, executionCount: number | null | undefined) {
  return `${executionCount ?? "none"}:${source}`;
}

export const IpynbPreview = memo(function IpynbPreview({
  cwd,
  relativePath,
  targetLine: _targetLine,
  executionTargetId,
  projectName,
  onBack,
  onCreateAnnotation,
}: IpynbPreviewProps) {
  const { state, loadPreview, refreshPreview } = usePreviewLoad({
    cwd,
    relativePath,
    executionTargetId,
  });
  const [selectedRange, setSelectedRange] = useState<LineRange | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [codeCellWidth, setCodeCellWidth] = useState<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const absolutePath = useMemo(
    () => buildAbsolutePreviewPath(cwd, relativePath),
    [cwd, relativePath],
  );

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  useFilePreviewRefresh({
    cwd,
    relativePath,
    executionTargetId,
    refreshPreview,
  });

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSelectedRange(null);
  }, [relativePath]);

  const notebook = useMemo(() => {
    if (!state.loaded || state.error) return null;
    try {
      return parseNotebook(state.contents);
    } catch {
      return null;
    }
  }, [state.contents, state.error, state.loaded]);

  const language = useMemo(
    () => (notebook ? detectNotebookLanguage(notebook) : "python"),
    [notebook],
  );

  const breadcrumb = useMemo(
    () => buildFilePreviewBreadcrumb(projectName, cwd, relativePath),
    [cwd, projectName, relativePath],
  );

  const parseError = useMemo(() => {
    if (!state.loaded || state.error) return null;
    try {
      parseNotebook(state.contents);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid notebook format.";
    }
  }, [state.contents, state.error, state.loaded]);

  const flatSource = useMemo(() => {
    if (!notebook) return "";
    return getNotebookFlatSource(notebook);
  }, [notebook]);

  const selectedFlatText = useMemo(() => {
    if (!selectedRange) return "";
    const lines = flatSource.split("\n");
    return lines.slice(selectedRange.startLine - 1, selectedRange.endLine).join("\n");
  }, [flatSource, selectedRange]);

  const handleNotebookContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const selectedText = window.getSelection()?.toString().trim() ?? "";
      let annotationRange: LineRange | null = null;
      if (onCreateAnnotation && selectedText.length >= 2) {
        const startIndex = flatSource.indexOf(selectedText);
        if (startIndex !== -1) {
          const endIndex = startIndex + selectedText.length;
          annotationRange = {
            startLine: flatSource.slice(0, startIndex).split("\n").length,
            endLine: flatSource.slice(0, endIndex).split("\n").length,
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
          selectElementContents(scrollContainerRef.current);
        },
        onAnnotateSelection:
          annotationRange === null
            ? undefined
            : () => {
                setSelectedRange(annotationRange);
              },
      });
    },
    [absolutePath, flatSource, onCreateAnnotation, relativePath],
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

  const annotationComposer = useMemo(() => {
    if (!selectedRange || !onCreateAnnotation) return null;
    return (
      <NotebookAnnotationComposer
        selectedRange={selectedRange}
        onCreateAnnotation={onCreateAnnotation}
        selectedFlatText={selectedFlatText}
        setSelectedRange={setSelectedRange}
      />
    );
  }, [selectedRange, onCreateAnnotation, selectedFlatText]);

  const measureSizer = useMemo(() => {
    if (!notebook) return null;
    const codeCells = notebook.cells.filter((c) => c.cell_type === "code");
    if (codeCells.length === 0) return null;

    return (
      <div ref={measureRef} aria-hidden="true" className="absolute invisible top-0 left-0 w-max">
        {codeCells.map((cell) => {
          const source = cellSource(cell);
          return (
            <div
              key={notebookSizerCellKey(source, cell.execution_count)}
              className="notebook-cell-code w-full"
            >
              <div className="rounded-md w-full">
                <div className="w-full bg-muted/50 px-16 py-8">
                  <SyntaxHighlightedCode
                    code={source}
                    language={language}
                    themeName={themeName}
                    bgTransparent
                    fallback={
                      <pre className="m-0 p-0 font-mono text-xs leading-5 text-foreground/85 whitespace-pre">
                        {source}
                      </pre>
                    }
                  />
                </div>
                <div className="w-full flex items-center justify-end px-3 py-1.5 bg-muted/50 border-t border-border/20">
                  <span className="text-xs text-muted-foreground/60 font-mono">{language}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }, [notebook, language, themeName]);

  useLayoutEffect(() => {
    if (!measureRef.current) {
      setCodeCellWidth(null);
      return;
    }
    const w = measureRef.current.scrollWidth;
    if (w > 0) setCodeCellWidth(w);
  }, [measureSizer]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {measureSizer}
      <FilePreviewHeader
        breadcrumb={breadcrumb}
        onBack={onBack}
        onContextMenu={handleHeaderContextMenu}
      />

      {shouldShowPreviewLoading(state) ? (
        <div className="p-3 text-sm text-muted-foreground/70">Loading notebook...</div>
      ) : state.error ? (
        <div className="flex gap-2 p-3 text-sm text-destructive/80">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      ) : parseError ? (
        <div className="flex gap-2 p-3 text-sm text-destructive/80">
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
          <span>Notebook parse error: {parseError}</span>
        </div>
      ) : notebook ? (
        <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
          {state.truncated ? (
            <div className="border-b border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              Notebook truncated. Content may be incomplete.
            </div>
          ) : null}
          <div className="notebook-cells min-w-full space-y-4 p-4">
            {notebook.cells.map((cell, cellIndex) => {
              const cellKey = `cell-${cellIndex}`;
              if (cell.cell_type === "markdown") {
                return (
                  <div
                    key={cellKey}
                    className="notebook-cell-markdown text-sm leading-relaxed text-foreground/80"
                    style={containerWidth != null ? { maxWidth: containerWidth } : undefined}
                    {...(onCreateAnnotation ? { onContextMenu: handleNotebookContextMenu } : {})}
                  >
                    <BaseMarkdown text={cellSource(cell)} cwd={cwd} />
                  </div>
                );
              }

              if (cell.cell_type === "raw") {
                return (
                  <pre
                    key={cellKey}
                    className="notebook-cell-raw m-0 whitespace-pre-wrap font-mono text-xs leading-5 text-foreground/70 min-w-0"
                    {...(onCreateAnnotation ? { onContextMenu: handleNotebookContextMenu } : {})}
                  >
                    {cellSource(cell)}
                  </pre>
                );
              }

              if (cell.cell_type === "code") {
                const source = cellSource(cell);
                const outputs = (cell.outputs ?? [])
                  .map(renderOutput)
                  .filter((o): o is OutputRendering => o !== null);
                const hasAnnotation = onCreateAnnotation != null;

                return (
                  <div
                    key={cellKey}
                    className="notebook-cell-code"
                    style={codeCellWidth != null ? { width: codeCellWidth } : undefined}
                  >
                    <div className="rounded-md w-full">
                      <div
                        className="w-full bg-muted/50 px-16 py-8"
                        {...(hasAnnotation ? { onContextMenu: handleNotebookContextMenu } : {})}
                      >
                        <SyntaxHighlightedCode
                          code={source}
                          language={language}
                          themeName={themeName}
                          bgTransparent
                          fallback={
                            <pre className="m-0 p-0 font-mono text-xs leading-5 text-foreground/85 whitespace-pre">
                              {source}
                            </pre>
                          }
                        />
                      </div>
                      <div className="w-full flex items-center justify-end px-3 py-1.5 bg-muted/50 border-t border-border/20">
                        <span className="text-xs text-muted-foreground/60 font-mono">
                          {language}
                        </span>
                      </div>
                    </div>
                    {outputs.length > 0 ? (
                      <div className="notebook-cell-outputs mt-2 space-y-1 border-l-2 border-border/50 pl-3">
                        {outputs.map((output) => {
                          const content =
                            output.text ??
                            output.html ??
                            output.imageSrc ??
                            output.svgContent ??
                            "";
                          const key = `${output.kind}-${content.length}-${content.slice(0, 30)}`;
                          return <OutputArea key={key} output={output} />;
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              }

              return null;
            })}
          </div>
          {annotationComposer}
        </div>
      ) : null}
    </div>
  );
});
