import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorktreeEntry } from "@bigbud/contracts/workspace/worktrees.ts";
import type { WorktreeBinding } from "@bigbud/contracts/workspace/worktreeBinding.ts";
import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts/core/baseSchemas.ts";
import { readNativeApi } from "../../rpc/nativeApi";
import { worktreeInventoryOptions, worktreeOperationsOptions } from "./worktreeReactQuery";
import type { WorktreeDialogTarget } from "./WorktreeToolbarDialog";
import { toastManager } from "../ui/toast";

export function useWorktreeToolbar(props: {
  cwd: string | null;
  selectedPath?: string | null;
  executionTargetId?: string;
  disabled: boolean;
  onSelect: (
    branch: string | null,
    worktreePath: string | null,
    existingCheckout?: boolean,
    binding?: WorktreeBinding,
  ) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const inventory = useQuery(
    worktreeInventoryOptions(props.cwd, props.executionTargetId, props.selectedPath),
  );
  const [target, setTarget] = useState<WorktreeDialogTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [showOperations, setShowOperations] = useState(false);
  const operations = useQuery(
    worktreeOperationsOptions(props.cwd, props.executionTargetId, showOperations),
  );
  const operationIds = useRef(new Map<string, string>());
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["worktrees"] });
    await queryClient.invalidateQueries({ queryKey: ["worktreeOperations"] });
    await queryClient.invalidateQueries({ queryKey: ["git"] });
    return inventory.refetch();
  };
  const select = async (entry: WorktreeEntry) => {
    if (props.disabled) throw new Error("Stop the active session before switching worktrees.");
    const latest = await inventory.refetch();
    const verified = latest.data?.entries.find((candidate) => candidate.path === entry.path);
    if (
      latest.isError ||
      !latest.data?.local ||
      latest.data.revision === undefined ||
      !verified?.identity ||
      entry.identity !== verified.identity ||
      verified.bare ||
      verified.locked !== null ||
      verified.prunable !== null
    )
      throw new Error("Worktree changed. Refresh and select again.");
    await props.onSelect(
      verified.branch,
      verified.path === latest.data?.checkoutPath ? null : verified.path,
      true,
      {
        path: verified.path,
        identity: verified.identity,
        repository: latest.data.repository,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        revision: latest.data.revision,
      },
    );
  };
  const submit = async (values: { name: string; branch: string; newBranch: string }) => {
    const api = readNativeApi()?.worktrees;
    if (!api || !props.cwd || !target) throw new Error("Worktree management is unavailable.");
    if (props.disabled && target.kind !== "create")
      throw new Error("Stop the active session before changing worktrees.");
    setPending(true);
    try {
      const context = {
        cwd: props.cwd,
        ...(props.executionTargetId ? { executionTargetId: props.executionTargetId } : {}),
      };
      const key = JSON.stringify([context, target, values]);
      const operationId = operationIds.current.get(key) ?? crypto.randomUUID();
      operationIds.current.set(key, operationId);
      if (target.kind === "create") {
        const created = await api.create({
          ...context,
          ...values,
          operationId,
        });
        const result = await refresh();
        const entry = result.data?.entries.find((candidate) => candidate.path === created.path);
        if (entry) {
          try {
            await select(entry);
          } catch (cause) {
            toastManager.add({
              type: "warning",
              title: "Worktree created, but not selected.",
              description: String(cause),
            });
          }
        } else
          toastManager.add({
            type: "warning",
            title: "Worktree created, but not selected.",
            description: created.path,
          });
      } else {
        const entry = target.entry;
        if (!entry?.identity)
          throw new Error("Worktree identity is unavailable. Refresh the inventory.");
        await api.delete({
          ...context,
          operationId,
          path: entry.path,
          expectedIdentity: entry.identity,
          expectedHead: entry.head,
          expectedBranch: entry.branch,
        });
        await refresh();
      }
      toastManager.add({
        type: "success",
        title: target.kind === "create" ? "Worktree created." : "Worktree deleted.",
      });
    } finally {
      setPending(false);
    }
  };
  const selectFromMenu = (entry: WorktreeEntry) => {
    setPending(true);
    void select(entry)
      .catch((cause) =>
        toastManager.add({
          type: "error",
          title: "Could not switch worktree.",
          description: String(cause),
        }),
      )
      .finally(() => setPending(false));
  };
  const selectExistingWorktree = async (path: string) => {
    const entry = inventory.data?.entries.find((candidate) => candidate.path === path);
    if (!entry?.identity)
      throw new Error("Worktree inventory is unavailable. Refresh and select again.");
    setPending(true);
    try {
      await select(entry);
    } finally {
      setPending(false);
    }
  };
  const recheckOperation = async (operationId: string) => {
    const api = readNativeApi()?.worktrees;
    if (!api || !props.cwd) throw new Error("Worktree recovery is unavailable.");
    const result = await api.recover({
      cwd: props.cwd,
      operationId,
      ...(props.executionTargetId ? { executionTargetId: props.executionTargetId } : {}),
    });
    await refresh();
    toastManager.add({
      type:
        result.phase === "completed"
          ? "success"
          : result.phase === "rejected"
            ? "error"
            : "warning",
      title:
        result.phase === "completed"
          ? "Worktree operation completed."
          : result.phase === "rejected"
            ? "Worktree operation rejected."
            : "Workspace remains reserved.",
      ...(result.error ? { description: result.error } : {}),
    });
  };
  return {
    inventory,
    target,
    setTarget,
    pending,
    refresh,
    submit,
    selectFromMenu,
    selectExistingWorktree,
    showOperations,
    setShowOperations,
    operations,
    recheckOperation,
  };
}
