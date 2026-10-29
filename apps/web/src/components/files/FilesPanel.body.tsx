import type { ProjectEntry } from "@bigbud/contracts/workspace/project";
import type { ReactNode } from "react";

import { BigbudLoader } from "~/components/layout/BigbudLoader";
import { WorkspaceRequestStatus } from "../common/WorkspaceRequestStatus";
import { EMPTY_ENTRIES, type DirectoryState } from "./FilesPanel.shared";
import { renderFilesPanelTree } from "./FilesPanel.tree";

interface FilesPanelTreeBodyInput {
  readonly showLoading: boolean | undefined;
  readonly remote?: boolean | undefined;
  readonly recovering?: boolean | undefined;
  readonly requestPending?: boolean | undefined;
  readonly onRetryDirectory?: ((path: string) => void) | undefined;
  readonly error: string | null | undefined;
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly workspaceRoot: string | null;
  readonly previewPath: string | null;
  readonly resolvedTheme: "light" | "dark";
  readonly expandedDirectories: Readonly<Record<string, boolean>>;
  readonly directoryStateByPath: Readonly<Record<string, DirectoryState>>;
  readonly onToggleDirectory: (entry: ProjectEntry) => void;
  readonly onOpenFile: (entry: ProjectEntry) => void;
  readonly onOpenContextMenu: (input: {
    path: string;
    kind: "file" | "directory";
    x: number;
    y: number;
  }) => void;
}

export function renderFilesPanelTreeBody(input: FilesPanelTreeBodyInput): ReactNode {
  if (input.showLoading && (!input.remote || (input.entries.length === 0 && !input.error))) {
    return (
      <BigbudLoader label={input.recovering ? "Reconnecting to workspace…" : "Loading files..."} />
    );
  }
  if (input.error && !input.remote) {
    return <div className="p-3 text-sm text-destructive/80">{input.error}</div>;
  }
  return (
    <div className="space-y-0.5 p-2">
      {input.remote && (input.showLoading || input.recovering || input.error) ? (
        <WorkspaceRequestStatus
          error={input.error}
          recovering={input.recovering}
          pending={input.requestPending}
          onRetry={() => input.onRetryDirectory?.("")}
        />
      ) : null}
      {renderFilesPanelTree({
        remote: input.remote,
        onRetryDirectory: input.onRetryDirectory,
        entries: input.entries ?? EMPTY_ENTRIES,
        depth: 0,
        workspaceRoot: input.workspaceRoot,
        previewPath: input.previewPath,
        resolvedTheme: input.resolvedTheme,
        expandedDirectories: input.expandedDirectories,
        directoryStateByPath: input.directoryStateByPath,
        onToggleDirectory: input.onToggleDirectory,
        onOpenFile: input.onOpenFile,
        onOpenContextMenu: input.onOpenContextMenu,
      })}
    </div>
  );
}
