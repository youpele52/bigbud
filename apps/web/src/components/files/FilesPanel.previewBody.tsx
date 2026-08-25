import type { ReactNode } from "react";

import {
  canMoveFileHistory,
  type FileHistory,
  type FileHistoryEntry,
} from "../../stores/files/filesPanel.history";
import type { CodeAnnotationDraft } from "./FilePreview";
import { FILE_PREVIEW_MIN_WIDTH } from "./FilesPanel.shared";
import { FilesPanelPreview } from "./FilesPanel.preview";

interface FilesPanelPreviewBodyInput {
  readonly workspaceRoot: string | null;
  readonly previewPath: string | null;
  readonly treeBody: ReactNode;
  readonly history: FileHistory;
  readonly historyEntry: FileHistoryEntry | undefined;
  readonly targetLine: number | undefined;
  readonly executionTargetId: string | undefined;
  readonly projectName: string | undefined;
  readonly fileTreeContainerRef: { current: HTMLDivElement | null };
  readonly fileTreeWidth: number;
  readonly onNavigateBack: () => void;
  readonly onNavigateForward: () => void;
  readonly onClose: () => void;
  readonly onPreviewLoadError: (error?: unknown) => void;
  readonly onScrollPositionChange: (scrollTop: number) => void;
  readonly onCreateAnnotation: ((annotation: CodeAnnotationDraft) => void) | undefined;
  readonly onSearchMatch: (line: number) => void;
  readonly onTreeResizeStart: (event: React.MouseEvent) => void;
}

export function renderFilesPanelPreviewBody(input: FilesPanelPreviewBodyInput): ReactNode {
  if (!input.workspaceRoot) {
    return (
      <div className="p-3 text-sm text-muted-foreground/70">Select a project to browse files.</div>
    );
  }
  if (!input.previewPath) {
    return <div className="h-full overflow-y-auto">{input.treeBody}</div>;
  }

  return (
    <div ref={input.fileTreeContainerRef} className="flex h-full min-h-0">
      <div className="min-h-0 flex-1" style={{ minWidth: FILE_PREVIEW_MIN_WIDTH }}>
        <FilesPanelPreview
          cwd={input.workspaceRoot}
          relativePath={input.previewPath}
          targetLine={input.targetLine}
          executionTargetId={input.executionTargetId}
          projectName={input.projectName}
          historyEntry={input.historyEntry}
          canNavigateBack={canMoveFileHistory(input.history, -1)}
          canNavigateForward={canMoveFileHistory(input.history, 1)}
          onNavigateBack={input.onNavigateBack}
          onNavigateForward={input.onNavigateForward}
          onClose={input.onClose}
          onPreviewLoadError={input.onPreviewLoadError}
          onScrollPositionChange={input.onScrollPositionChange}
          onCreateAnnotation={input.onCreateAnnotation}
          onSearchMatch={input.onSearchMatch}
        />
      </div>
      <div
        className="z-10 w-[3px] shrink-0 cursor-col-resize select-none hover:bg-primary/30"
        role="separator"
        onMouseDown={input.onTreeResizeStart}
      />
      <div
        className="min-h-0 overflow-y-auto border-l border-border"
        style={{ width: input.fileTreeWidth }}
      >
        {input.treeBody}
      </div>
    </div>
  );
}
