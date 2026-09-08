import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import { TriangleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AnnotationGutterTrigger } from "../annotations/AnnotationGutterTrigger";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { DIFF_PANEL_UNSAFE_CSS } from "./DiffPanel.styles";
import { isDiffFileTitleClick } from "./diffPanelFileOpen.logic";
import type { DiffRenderMode } from "./DiffPanel.logic";
import {
  resolveDiffSelectionFromPierreLineRange,
  resolveDiffSelectionFromVisualLine,
} from "./diffSelection.logic.pierre";
import type { ResolvedDiffSelection } from "./diffSelection.logic";

type DiffThemeType = "light" | "dark";

interface DiffPanelFileProps {
  fileDiff: FileDiffMetadata;
  filePath: string;
  themedFileKey: string;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  resolvedTheme: "light" | "dark";
  canAnnotate: boolean;
  activeAnnotationRange?: { readonly startLine: number; readonly endLine: number } | undefined;
  selectionOwnerFilePath: string | null;
  onOpenInFilesPanel: (filePath: string) => void;
  onPierreLineSelectionChange: (filePath: string, range: SelectedLineRange | null) => void;
  onAnnotationRequest: (
    selection: ResolvedDiffSelection,
    position: { readonly clientX: number; readonly clientY: number },
  ) => void;
}

export function DiffPanelFile({
  fileDiff,
  filePath,
  themedFileKey,
  diffRenderMode,
  diffWordWrap,
  resolvedTheme,
  canAnnotate,
  activeAnnotationRange,
  selectionOwnerFilePath,
  onOpenInFilesPanel,
  onPierreLineSelectionChange,
  onAnnotationRequest,
}: DiffPanelFileProps) {
  const lastPointerPositionRef = useRef({ clientX: 0, clientY: 0 });
  const suppressGutterClickUntilRef = useRef(0);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);

  useEffect(() => {
    if (selectionOwnerFilePath !== filePath) setSelectedLines(null);
  }, [filePath, selectionOwnerFilePath]);

  const selectedLineNumber = selectedLines
    ? Math.max(selectedLines.start, selectedLines.end)
    : activeAnnotationRange?.endLine;
  const selectedLineSide = selectedLines
    ? selectedLines.start >= selectedLines.end
      ? (selectedLines.side ?? selectedLines.endSide)
      : (selectedLines.endSide ?? selectedLines.side)
    : undefined;

  return (
    <div
      key={themedFileKey}
      data-diff-file-path={filePath}
      className="diff-render-file mb-3 rounded-md first:mt-3 last:mb-0"
      onPointerDownCapture={(event) => {
        lastPointerPositionRef.current = { clientX: event.clientX, clientY: event.clientY };
      }}
      onClickCapture={(event) => {
        if (!isDiffFileTitleClick(event)) return;
        onOpenInFilesPanel(filePath);
      }}
    >
      <FileDiff
        fileDiff={fileDiff}
        renderGutterUtility={(getHoveredLine) => {
          const currentLine = getHoveredLine();
          return (
            <AnnotationGutterTrigger
              ariaLabel="Annotate hovered diff line"
              active={
                currentLine?.lineNumber === selectedLineNumber &&
                (selectedLineSide === undefined || currentLine?.side === selectedLineSide)
              }
              className="w-full"
              onClick={(event) => {
                if (performance.now() < suppressGutterClickUntilRef.current) return;
                event.stopPropagation();
                const hoveredLine = getHoveredLine();
                if (!hoveredLine) return;
                const range = {
                  start: hoveredLine.lineNumber,
                  end: hoveredLine.lineNumber,
                  side: hoveredLine.side,
                } satisfies SelectedLineRange;
                setSelectedLines(range);
                onPierreLineSelectionChange(filePath, range);
                const selection = resolveDiffSelectionFromVisualLine(
                  filePath,
                  fileDiff,
                  hoveredLine.lineNumber,
                  hoveredLine.side,
                );
                if (selection) {
                  onAnnotationRequest(selection, {
                    clientX: event.clientX,
                    clientY: event.clientY,
                  });
                }
              }}
            />
          );
        }}
        selectedLines={selectedLines}
        renderHeaderPrefix={(diff) =>
          diff.type === "change" ||
          diff.type === "rename-changed" ||
          diff.type === "rename-pure" ? (
            <TriangleIcon aria-hidden="true" className="size-3 text-amber-500" strokeWidth={3} />
          ) : null
        }
        options={{
          diffStyle: diffRenderMode === "split" ? "split" : "unified",
          lineDiffType: "none",
          overflow: diffWordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme as DiffThemeType,
          unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
          enableGutterUtility: canAnnotate,
          enableLineSelection: canAnnotate,
          controlledSelection: true,
          onLineSelectionChange: setSelectedLines,
          onLineSelectionEnd: (range) => {
            setSelectedLines(range);
            onPierreLineSelectionChange(filePath, range);
            if (!range) return;
            const side = range.side ?? "additions";
            const endSide = range.endSide ?? side;
            const selection =
              range.start === range.end && side === endSide
                ? resolveDiffSelectionFromVisualLine(filePath, fileDiff, range.start, side)
                : resolveDiffSelectionFromPierreLineRange(
                    filePath,
                    fileDiff,
                    range,
                    diffRenderMode === "split" ? "split" : "unified",
                  );
            if (selection) {
              suppressGutterClickUntilRef.current = performance.now() + 100;
              onAnnotationRequest(selection, lastPointerPositionRef.current);
            }
          },
        }}
      />
    </div>
  );
}
