import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import { DIFF_PANEL_UNSAFE_CSS } from "./DiffPanel.styles";
import type { DiffRenderMode } from "./DiffPanel.logic";

type DiffThemeType = "light" | "dark";

interface DiffPanelFileProps {
  fileDiff: FileDiffMetadata;
  filePath: string;
  themedFileKey: string;
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  resolvedTheme: "light" | "dark";
  canAnnotate: boolean;
  onOpenInFilesPanel: (filePath: string) => void;
  onPierreLineSelectionChange: (filePath: string, range: SelectedLineRange | null) => void;
}

export function DiffPanelFile({
  fileDiff,
  filePath,
  themedFileKey,
  diffRenderMode,
  diffWordWrap,
  resolvedTheme,
  canAnnotate,
  onOpenInFilesPanel,
  onPierreLineSelectionChange,
}: DiffPanelFileProps) {
  return (
    <div
      key={themedFileKey}
      data-diff-file-path={filePath}
      className="diff-render-file mb-3 rounded-md first:mt-3 last:mb-0"
      onClickCapture={(event) => {
        const nativeEvent = event.nativeEvent as MouseEvent;
        const composedPath = nativeEvent.composedPath?.() ?? [];
        const clickedHeader = composedPath.some((node) => {
          if (!(node instanceof Element)) return false;
          return node.hasAttribute("data-title");
        });
        if (!clickedHeader) return;
        onOpenInFilesPanel(filePath);
      }}
    >
      <FileDiff
        fileDiff={fileDiff}
        options={{
          diffStyle: diffRenderMode === "split" ? "split" : "unified",
          lineDiffType: "none",
          overflow: diffWordWrap ? "wrap" : "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme as DiffThemeType,
          unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
          enableLineSelection: canAnnotate,
          onLineSelectionEnd: (range) => {
            onPierreLineSelectionChange(filePath, range);
          },
        }}
      />
    </div>
  );
}
