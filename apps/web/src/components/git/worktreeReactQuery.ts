import { queryOptions } from "@tanstack/react-query";
import { readNativeApi } from "../../rpc/nativeApi";

export function worktreeInventoryOptions(
  cwd: string | null,
  executionTargetId?: string,
  selectedPath?: string | null,
) {
  return queryOptions({
    queryKey: ["worktrees", executionTargetId ?? "local", cwd, selectedPath ?? null],
    enabled: cwd !== null && readNativeApi()?.worktrees !== undefined,
    queryFn: async () => {
      const api = readNativeApi()?.worktrees;
      if (!api || !cwd) throw new Error("Worktree inventory is unavailable.");
      return api.list({
        cwd,
        ...(executionTargetId ? { executionTargetId } : {}),
        ...(selectedPath ? { selectedPath } : {}),
      });
    },
    staleTime: 5_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
}

export function worktreeOperationsOptions(
  cwd: string | null,
  executionTargetId?: string,
  visible = true,
) {
  return queryOptions({
    queryKey: ["worktreeOperations", executionTargetId ?? "local", cwd],
    enabled:
      visible &&
      cwd !== null &&
      (!executionTargetId || executionTargetId === "local") &&
      readNativeApi()?.worktrees !== undefined,
    queryFn: async () => {
      const api = readNativeApi()?.worktrees;
      if (!api || !cwd) throw new Error("Worktree diagnostics are unavailable.");
      return api.operations({ cwd, ...(executionTargetId ? { executionTargetId } : {}) });
    },
    staleTime: 0,
  });
}
