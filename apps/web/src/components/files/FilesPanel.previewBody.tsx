import type { ReactNode } from "react";

import {
  canMoveFileHistory,
  type FileHistory,
  type FileHistoryEntry,
} from "../../stores/files/filesPanel.history";
import type { CodeAnnotationDraft } from "./FilePreview";
import { FilesPanelPreview } from "./FilesPanel.preview";
import { FilesPanelLayout } from "./FilesPanel.layout";

interface FilesPanelPreviewBodyInput {
  readonly workspaceRoot: string | null;
  readonly previewPath: string | null;
  readonly treeBody: ReactNode;
  readonly history: FileHistory;
  readonly historyEntry: FileHistoryEntry | undefined;
  readonly targetLine: number | undefined;
  readonly executionTargetId: string | undefined;
  readonly projectName: string | undefined;
  readonly workspaceKey: string;
  readonly contextMenuOpen: boolean;
  readonly visible?: boolean;
  readonly onNavigateBack: () => void;
  readonly onNavigateForward: () => void;
  readonly onClose: () => void;
  readonly onPreviewLoadError: (error?: unknown) => void;
  readonly onScrollPositionChange: (scrollTop: number) => void;
  readonly onCreateAnnotation: ((annotation: CodeAnnotationDraft) => void) | undefined;
  readonly onSearchMatch: (line: number) => void;
}

export function renderFilesPanelPreviewBody(input: FilesPanelPreviewBodyInput): ReactNode {
  return (
    <FilesPanelLayout
      workspaceKey={input.workspaceKey}
      contextMenuOpen={input.contextMenuOpen}
      visible={input.visible ?? true}
      hasPreview={Boolean(input.workspaceRoot && input.previewPath)}
      treeBody={
        input.workspaceRoot ? (
          input.treeBody
        ) : (
          <div className="p-3 text-sm text-muted-foreground/70">
            Select a project to browse files.
          </div>
        )
      }
      preview={
        input.workspaceRoot && input.previewPath ? (
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
        ) : null
      }
    />
  );
}
