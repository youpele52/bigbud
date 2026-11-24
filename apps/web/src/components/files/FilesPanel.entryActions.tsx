import type { ProjectEntry } from "@bigbud/contracts";
import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import { useMemo, useState, type ReactNode } from "react";

import { FilesPanelAddMenu } from "./FilesPanel.addMenu";
import { FilesPanelDeleteDialog } from "./FilesPanel.deleteDialog";
import { entryActionDisabledReason, type NewEntryKind } from "./FilesPanel.entryActions.logic";
import { FilesPanelNewEntryInput } from "./FilesPanel.newEntryInput";
import type { FilesPanelPendingEntrySlot } from "./FilesPanel.tree";
import { useFilesPanelEntryActions } from "./useFilesPanelEntryActions";

interface FilesPanelEntryActionsUiInput {
  readonly workspaceRoot: string | null;
  readonly executionTargetId: string | undefined;
  readonly expandedDirectories: Readonly<Record<string, boolean>>;
  readonly loadDirectory: (path: string, options?: { force?: boolean }) => Promise<void> | void;
  readonly onOpenFile: (entry: ProjectEntry) => void;
  readonly resolvedTheme: "light" | "dark";
}

/** Files panel create/delete UI: header add menu, inline input, Delete… and its confirmation. */
export function useFilesPanelEntryActionsUi(input: FilesPanelEntryActionsUiInput) {
  const entryActions = useFilesPanelEntryActions(input);
  const { actions, pendingEntry, startCreate, cancelCreate, submitCreate } = entryActions;
  const [revealTreeSignal, setRevealTreeSignal] = useState(0);
  const remote = isRemoteExecutionTargetId(input.executionTargetId);

  const headerActions: ReactNode = input.workspaceRoot ? (
    <FilesPanelAddMenu
      actions={actions}
      onOpen={entryActions.refreshActions}
      onChoose={(kind: NewEntryKind) => {
        startCreate(kind);
        setRevealTreeSignal((value) => value + 1);
      }}
    />
  ) : null;

  const { resolvedTheme } = input;
  const pendingEntrySlot = useMemo<FilesPanelPendingEntrySlot | null>(
    () =>
      pendingEntry
        ? {
            parentPath: pendingEntry.parentPath,
            render: (depth) => (
              <FilesPanelNewEntryInput
                key={`${pendingEntry.kind}:${pendingEntry.parentPath}`}
                pending={pendingEntry}
                depth={depth}
                resolvedTheme={resolvedTheme}
                onSubmit={(name) => void submitCreate(name)}
                onCancel={cancelCreate}
              />
            ),
          }
        : null,
    [cancelCreate, pendingEntry, resolvedTheme, submitCreate],
  );

  const deleteDialog = (
    <FilesPanelDeleteDialog
      target={entryActions.deleteTarget}
      permanent={actions?.delete.permanent ?? true}
      remote={remote}
      busy={entryActions.deleteBusy}
      onCancel={entryActions.cancelDelete}
      onConfirm={() => void entryActions.confirmDelete()}
    />
  );

  return {
    headerActions,
    revealTreeSignal,
    pendingEntrySlot,
    deleteDialog,
    noteDirectoryToggled: entryActions.noteDirectoryToggled,
    contextMenuDelete: {
      onDelete: entryActions.requestDelete,
      deleteDisabledReason: entryActionDisabledReason(actions?.delete),
    },
  };
}
