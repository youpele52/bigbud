import { Virtualizer } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  Rows3Icon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { useTheme } from "../../hooks/useTheme";
import { openFileInFilesPanel } from "../../stores/files/filesPanel.coordinator";
import { useSettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../utils/timestamp";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { ToggleGroup, Toggle } from "../ui/toggle-group";
import { Button } from "../ui/button";
import {
  type DiffRenderMode,
  getRenderablePatch,
  resolveFileDiffPath,
  buildFileDiffRenderKey,
  useTurnStripScroll,
  useDiffPanelData,
} from "./DiffPanel.logic";
import { useComposerDraftStore } from "../../stores/composer";
import { makeAnnotationId } from "../files/FilesPanel.shared";
import type { CodeAnnotationDraft } from "../files/FilePreview";
import { DiffPanelAnnotationComposer, type PendingDiffAnnotation } from "./DiffPanel.annotations";
import { DiffPanelFile } from "./DiffPanelFile";
import { useDiffAnnotateContextMenu } from "./useDiffAnnotateContextMenu";

interface DiffPanelProps {
  mode?: DiffPanelMode;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline" }: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingDiffAnnotation | null>(null);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const pierreLineSelectionsRef = useRef(new Map<string, SelectedLineRange | null>());
  const previousDiffOpenRef = useRef(false);
  const addAnnotation = useComposerDraftStore((state) => state.addAnnotation);

  const {
    turnStripRef,
    canScrollTurnStripLeft,
    canScrollTurnStripRight,
    updateTurnStripScrollState,
    scrollTurnStripBy,
    onTurnStripWheel,
  } = useTurnStripScroll();

  const {
    diffOpen,
    activeThread,
    activeThreadId,
    activeProject,
    activeCwd,
    isGitRepo,
    orderedTurnDiffSummaries,
    inferredCheckpointTurnCountByTurnId,
    selectedTurnId,
    selectedFilePath,
    selectedTurn,
    selectedTurnCheckpointDiff,
    conversationCheckpointDiff,
    isLoadingCheckpointDiff,
    checkpointDiffError,
    selectTurn,
    selectWholeConversation,
    closeDiff,
  } = useDiffPanelData();

  const canAnnotate = Boolean(activeThreadId && activeCwd);

  const selectedPatch = selectedTurn ? selectedTurnCheckpointDiff : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`),
    [resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);

  const fileDiffByPath = useMemo(() => {
    const map = new Map<string, (typeof renderableFiles)[number]>();
    for (const fileDiff of renderableFiles) {
      map.set(resolveFileDiffPath(fileDiff), fileDiff);
    }
    return map;
  }, [renderableFiles]);

  const handlePierreLineSelectionChange = useCallback(
    (filePath: string, range: SelectedLineRange | null) => {
      pierreLineSelectionsRef.current.set(filePath, range);
    },
    [],
  );

  useDiffAnnotateContextMenu({
    viewportRef: patchViewportRef,
    canAnnotate,
    fileDiffByPath,
    pierreLineSelectionsRef,
    onAnnotateRequest: setPendingAnnotation,
  });

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffWordWrap]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

  const openDiffFileInViewer = useCallback((filePath: string) => {
    openFileInFilesPanel(filePath);
  }, []);

  const handleCreateCodeAnnotation = useCallback(
    (annotation: CodeAnnotationDraft, filePath: string) => {
      if (!activeThreadId || !activeCwd) {
        return;
      }
      addAnnotation(activeThreadId, {
        id: makeAnnotationId(),
        kind: "code",
        comment: annotation.comment,
        intent: annotation.intent,
        createdAt: new Date().toISOString(),
        file: {
          ...(activeProject?.name ? { projectName: activeProject.name } : {}),
          cwd: activeCwd,
          relativePath: filePath,
        },
        selection: {
          startLine: annotation.startLine,
          endLine: annotation.endLine,
          text: annotation.text,
        },
      });
    },
    [activeCwd, activeProject?.name, activeThreadId, addAnnotation],
  );

  useEffect(() => {
    setPendingAnnotation(null);
    pierreLineSelectionsRef.current.clear();
  }, [selectedTurnId, selectedPatch]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => updateTurnStripScrollState());
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [orderedTurnDiffSummaries, selectedTurnId, updateTurnStripScrollState]);

  useEffect(() => {
    const element = turnStripRef.current;
    if (!element) return;
    const selectedChip = element.querySelector<HTMLElement>("[data-turn-chip-selected='true']");
    selectedChip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedTurn?.turnId, selectedTurnId, turnStripRef]);

  const headerRow = (
    <>
      <div className="relative min-w-0 flex-1 [-webkit-app-region:no-drag]">
        <button
          type="button"
          className={cn(
            "absolute left-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripLeft
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(-180)}
          disabled={!canScrollTurnStripLeft}
          aria-label="Scroll turn list left"
        >
          <ChevronLeftIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className={cn(
            "absolute right-0 top-1/2 z-20 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-md border bg-background/90 text-muted-foreground transition-colors",
            canScrollTurnStripRight
              ? "border-border/70 hover:border-border hover:text-foreground"
              : "cursor-not-allowed border-border/40 text-muted-foreground/40",
          )}
          onClick={() => scrollTurnStripBy(180)}
          disabled={!canScrollTurnStripRight}
          aria-label="Scroll turn list right"
        >
          <ChevronRightIcon className="size-3.5" />
        </button>
        <div
          ref={turnStripRef}
          className="turn-chip-strip flex gap-1 overflow-x-auto px-6 py-0.5"
          style={
            canScrollTurnStripLeft || canScrollTurnStripRight
              ? {
                  maskImage: `linear-gradient(to right, ${canScrollTurnStripLeft ? "transparent 24px, black 72px" : "black"}, ${canScrollTurnStripRight ? "black calc(100% - 72px), transparent calc(100% - 24px)" : "black"})`,
                }
              : undefined
          }
          onWheel={onTurnStripWheel}
        >
          <button
            type="button"
            className="shrink-0 rounded-md"
            onClick={selectWholeConversation}
            data-turn-chip-selected={selectedTurnId === null}
          >
            <div
              className={cn(
                "rounded-md border px-2 py-1 text-left transition-colors",
                selectedTurnId === null
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
              )}
            >
              <div className="text-[10px] leading-tight font-medium">All turns</div>
            </div>
          </button>
          {orderedTurnDiffSummaries.map((summary) => (
            <button
              key={summary.turnId}
              type="button"
              className="shrink-0 rounded-md"
              onClick={() => selectTurn(summary.turnId)}
              title={summary.turnId}
              data-turn-chip-selected={summary.turnId === selectedTurn?.turnId}
            >
              <div
                className={cn(
                  "rounded-md border px-2 py-1 text-left transition-colors",
                  summary.turnId === selectedTurn?.turnId
                    ? "border-border bg-accent text-accent-foreground"
                    : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/80",
                )}
              >
                <div className="flex items-center gap-1">
                  <span className="text-[10px] leading-tight font-medium">
                    Turn{" "}
                    {summary.checkpointTurnCount ??
                      inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                      "?"}
                  </span>
                  <span className="text-[9px] leading-tight opacity-70">
                    {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleGroup
          className="shrink-0"
          variant="toolbar"
          size="xs"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              setDiffRenderMode(next);
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
            <Columns2Icon className="size-3" />
          </Toggle>
        </ToggleGroup>
        <Toggle
          aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
          title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          variant="toolbar"
          size="xs"
          pressed={diffWordWrap}
          onPressedChange={(pressed) => {
            setDiffWordWrap(Boolean(pressed));
          }}
        >
          <TextWrapIcon className="size-3" />
        </Toggle>
        <Button variant="toolbar" size="icon-xs" onClick={closeDiff} aria-label="Close diff panel">
          <XIcon className="size-3" />
        </Button>
      </div>
    </>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport relative min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-destructive-foreground/80">
                  {checkpointDiffError}
                </p>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingCheckpointDiff ? (
                <DiffPanelLoadingState label="Loading checkpoint diff..." />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-3 pb-3"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  return (
                    <DiffPanelFile
                      key={themedFileKey}
                      fileDiff={fileDiff}
                      filePath={filePath}
                      themedFileKey={themedFileKey}
                      diffRenderMode={diffRenderMode}
                      diffWordWrap={diffWordWrap}
                      resolvedTheme={resolvedTheme}
                      canAnnotate={canAnnotate}
                      onOpenInFilesPanel={openDiffFileInViewer}
                      onPierreLineSelectionChange={handlePierreLineSelectionChange}
                    />
                  );
                })}
              </Virtualizer>
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
            {pendingAnnotation ? (
              <DiffPanelAnnotationComposer
                pendingAnnotation={pendingAnnotation}
                onCreateAnnotation={(annotation) =>
                  handleCreateCodeAnnotation(annotation, pendingAnnotation.filePath)
                }
                onCancel={() => setPendingAnnotation(null)}
              />
            ) : null}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
