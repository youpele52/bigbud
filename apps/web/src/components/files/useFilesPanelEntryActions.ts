import type { ProjectEntry } from "@bigbud/contracts";
import type { ProjectEntryActions } from "@bigbud/contracts/workspace/projectEntryMutation";
import { useCallback, useEffect, useRef, useState } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";
import {
  createEntryErrorMessage,
  joinRelativeEntryPath,
  parentRelativePath,
  resolveCreateTargetFolder,
  validateNewEntryName,
  type DeleteEntryTarget,
  type NewEntryKind,
} from "./FilesPanel.entryActions.logic";

export interface PendingNewEntry {
  readonly kind: NewEntryKind;
  readonly parentPath: string;
  readonly error: string | null;
  readonly busy: boolean;
}

interface UseFilesPanelEntryActionsInput {
  readonly workspaceRoot: string | null;
  readonly executionTargetId: string | undefined;
  readonly expandedDirectories: Readonly<Record<string, boolean>>;
  readonly loadDirectory: (path: string, options?: { force?: boolean }) => Promise<void> | void;
  readonly onOpenFile: (entry: ProjectEntry) => void;
}

/** Files panel create (file or folder) and delete state, gated by server-reported actions. */
export function useFilesPanelEntryActions(input: UseFilesPanelEntryActionsInput) {
  const { workspaceRoot, executionTargetId, expandedDirectories, loadDirectory, onOpenFile } =
    input;
  const [actions, setActions] = useState<ProjectEntryActions | null>(null);
  const [pendingEntry, setPendingEntry] = useState<PendingNewEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteEntryTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const lastToggledFolder = useRef<string | null>(null);
  const workspaceIdentity = `${workspaceRoot ?? ""}\u0000${executionTargetId ?? ""}`;
  const currentIdentity = useRef(workspaceIdentity);
  currentIdentity.current = workspaceIdentity;

  const refreshActions = useCallback(() => {
    const api = readNativeApi();
    if (!api || !workspaceRoot) return;
    const requested = workspaceIdentity;
    void api.projects
      .entryActions({ cwd: workspaceRoot, ...(executionTargetId ? { executionTargetId } : {}) })
      .then(
        (result) => {
          if (currentIdentity.current === requested) setActions(result);
        },
        () => {
          if (currentIdentity.current === requested) setActions(null);
        },
      );
  }, [executionTargetId, workspaceIdentity, workspaceRoot]);

  useEffect(() => {
    setActions(null);
    setPendingEntry(null);
    setDeleteTarget(null);
    lastToggledFolder.current = null;
    refreshActions();
  }, [refreshActions]);

  const noteDirectoryToggled = useCallback((path: string) => {
    lastToggledFolder.current = path;
  }, []);

  const startCreate = useCallback(
    (kind: NewEntryKind) => {
      const parentPath = resolveCreateTargetFolder(lastToggledFolder.current, expandedDirectories);
      setPendingEntry({ kind, parentPath, error: null, busy: false });
    },
    [expandedDirectories],
  );

  const cancelCreate = useCallback(() => setPendingEntry(null), []);

  const submitCreate = useCallback(
    async (rawName: string) => {
      const pending = pendingEntry;
      const api = readNativeApi();
      if (!pending || pending.busy || !api || !workspaceRoot) return;
      const name = rawName.trim();
      const invalid = validateNewEntryName(name);
      if (invalid) {
        setPendingEntry({ ...pending, error: invalid });
        return;
      }
      const relativePath = joinRelativeEntryPath(pending.parentPath, name);
      const target = { cwd: workspaceRoot, ...(executionTargetId ? { executionTargetId } : {}) };
      setPendingEntry({ ...pending, busy: true, error: null });
      try {
        if (pending.kind === "folder") {
          await api.projects.createDirectory({ ...target, relativePath });
        } else {
          // Exclusive create: an existing entry is reported, never overwritten.
          await api.projects.writeFile({ ...target, relativePath, contents: "", createOnly: true });
        }
      } catch (error) {
        setPendingEntry({ ...pending, busy: false, error: createEntryErrorMessage(error, name) });
        return;
      }
      setPendingEntry(null);
      void loadDirectory(pending.parentPath, { force: true });
      if (pending.kind === "file") {
        onOpenFile({
          path: relativePath,
          kind: "file",
          ...(pending.parentPath ? { parentPath: pending.parentPath } : {}),
        });
      }
    },
    [executionTargetId, loadDirectory, onOpenFile, pendingEntry, workspaceRoot],
  );

  const requestDelete = useCallback((target: DeleteEntryTarget) => {
    setDeleteBusy(false);
    setDeleteTarget(target);
  }, []);

  const cancelDelete = useCallback(() => {
    if (!deleteBusy) setDeleteTarget(null);
  }, [deleteBusy]);

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    const api = readNativeApi();
    if (!target || deleteBusy || !api || !workspaceRoot) return;
    setDeleteBusy(true);
    try {
      await api.projects.deleteEntry({
        cwd: workspaceRoot,
        ...(executionTargetId ? { executionTargetId } : {}),
        relativePath: target.relativePath,
        expectedKind: target.kind,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't delete",
        description: error instanceof Error ? error.message : "The request could not be sent.",
      });
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
      // Reload either way: a failure part-way may still have removed something.
      void loadDirectory(parentRelativePath(target.relativePath), { force: true });
    }
  }, [deleteBusy, deleteTarget, executionTargetId, loadDirectory, workspaceRoot]);

  return {
    actions,
    refreshActions,
    noteDirectoryToggled,
    pendingEntry,
    startCreate,
    cancelCreate,
    submitCreate,
    deleteTarget,
    deleteBusy,
    requestDelete,
    cancelDelete,
    confirmDelete,
  };
}

export type FilesPanelEntryActions = ReturnType<typeof useFilesPanelEntryActions>;
