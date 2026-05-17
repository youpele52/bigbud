import { useCallback } from "react";

import { type ProjectId, type ThreadId } from "@bigbud/contracts";

import { DEFAULT_THREAD_TERMINAL_ID } from "../../models/types";
import { readNativeApi } from "../../rpc/nativeApi";
import type { SidebarThreadSummary } from "../../models/types";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useTerminalStateStore } from "../../stores/terminal";
import { toastManager } from "../ui/toast";
import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";
import { isRemoteExecutionTargetId } from "./Sidebar.projects.logic";

interface PendingRemoteThreadActivation {
  readonly threadId: ThreadId;
  readonly executionTargetId: string;
  readonly cwd?: string;
  readonly worktreePath?: string;
}

export interface SidebarRemoteThreadActivationInput {
  readonly sidebarThreadsById: Record<ThreadId, SidebarThreadSummary | undefined>;
  readonly projectCwdById: Map<ProjectId, string | null>;
  readonly navigateToThreadRoute: (threadId: ThreadId) => void;
}

export interface SidebarRemoteThreadActivationOutput {
  readonly navigateToThread: (threadId: ThreadId) => void;
}

export function resolveRemoteThreadActivation(
  thread: SidebarThreadSummary | undefined,
  projectCwdById: Map<ProjectId, string | null>,
): PendingRemoteThreadActivation | null {
  if (!thread) {
    return null;
  }

  const executionTargetId = resolveWorkspaceExecutionTargetId(thread);
  if (!isRemoteExecutionTargetId(executionTargetId)) {
    return null;
  }

  const cwd = thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? undefined;
  return {
    threadId: thread.id,
    executionTargetId,
    ...(cwd ? { cwd } : {}),
    ...(thread.worktreePath ? { worktreePath: thread.worktreePath } : {}),
  };
}

export function useSidebarRemoteThreadActivation({
  sidebarThreadsById,
  projectCwdById,
  navigateToThreadRoute,
}: SidebarRemoteThreadActivationInput): SidebarRemoteThreadActivationOutput {
  const { ensureRemoteExecutionTargetAccess } = useRemoteExecutionAccessGate();

  const reconnectRemoteThreadTerminals = useCallback(
    async (activation: PendingRemoteThreadActivation) => {
      if (!activation.cwd) {
        return;
      }

      const api = readNativeApi();
      if (!api) {
        return;
      }

      const terminalState =
        useTerminalStateStore.getState().terminalStateByThreadId[activation.threadId];
      if (!terminalState?.terminalOpen) {
        return;
      }

      const terminalIds =
        terminalState.terminalIds.length > 0
          ? terminalState.terminalIds
          : [DEFAULT_THREAD_TERMINAL_ID];

      await Promise.all(
        terminalIds.map((terminalId) =>
          api.terminal.open({
            threadId: activation.threadId,
            executionTargetId: activation.executionTargetId,
            terminalId,
            cwd: activation.cwd!,
            ...(activation.worktreePath ? { worktreePath: activation.worktreePath } : {}),
          }),
        ),
      );
    },
    [],
  );

  const navigateToThread = useCallback(
    (threadId: ThreadId) => {
      const thread = sidebarThreadsById[threadId];
      const activation = resolveRemoteThreadActivation(thread, projectCwdById);
      if (!activation) {
        navigateToThreadRoute(threadId);
        return;
      }

      void (async () => {
        await ensureRemoteExecutionTargetAccess({
          executionTargetId: activation.executionTargetId,
          ...(activation.cwd ? { cwd: activation.cwd } : {}),
          onVerified: async () => {
            navigateToThreadRoute(threadId);
            await reconnectRemoteThreadTerminals(activation).catch((error) => {
              toastManager.add({
                type: "error",
                title: "Failed to refresh remote terminal",
                description:
                  error instanceof Error ? error.message : "An error occurred while reconnecting.",
              });
            });
          },
        });
      })();
    },
    [
      ensureRemoteExecutionTargetAccess,
      navigateToThreadRoute,
      projectCwdById,
      reconnectRemoteThreadTerminals,
      sidebarThreadsById,
    ],
  );

  return {
    navigateToThread,
  };
}
