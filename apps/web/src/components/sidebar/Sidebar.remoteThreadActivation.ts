import { useCallback, useRef, useState } from "react";

import { type ProjectId, type ThreadId } from "@bigbud/contracts";

import { DEFAULT_THREAD_TERMINAL_ID } from "../../models/types";
import { readNativeApi } from "../../rpc/nativeApi";
import type { SidebarThreadSummary } from "../../models/types";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { useTerminalStateStore } from "../../stores/terminal";
import { getPassphraseProtectedSshKeyPath } from "../../lib/ssh";
import { toastManager } from "../ui/toast";
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
  readonly isRemoteThreadUnlockDialogOpen: boolean;
  readonly remoteThreadUnlockKeyPath: string;
  readonly remoteThreadUnlockPassphrase: string;
  readonly remoteThreadUnlockError: string | null;
  readonly isUnlockingRemoteThreadKey: boolean;
  readonly closeRemoteThreadUnlockDialog: () => void;
  readonly setRemoteThreadUnlockPassphrase: (passphrase: string) => void;
  readonly submitRemoteThreadUnlock: () => Promise<void>;
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
  const pendingActivationRef = useRef<PendingRemoteThreadActivation | null>(null);
  const [isRemoteThreadUnlockDialogOpen, setIsRemoteThreadUnlockDialogOpen] = useState(false);
  const [remoteThreadUnlockKeyPath, setRemoteThreadUnlockKeyPath] = useState("");
  const [remoteThreadUnlockPassphrase, setRemoteThreadUnlockPassphrase] = useState("");
  const [remoteThreadUnlockError, setRemoteThreadUnlockError] = useState<string | null>(null);
  const [isUnlockingRemoteThreadKey, setIsUnlockingRemoteThreadKey] = useState(false);

  const resetUnlockDialog = useCallback(() => {
    setIsRemoteThreadUnlockDialogOpen(false);
    setRemoteThreadUnlockKeyPath("");
    setRemoteThreadUnlockPassphrase("");
    setRemoteThreadUnlockError(null);
  }, []);

  const closeRemoteThreadUnlockDialog = useCallback(() => {
    if (isUnlockingRemoteThreadKey) {
      return;
    }
    pendingActivationRef.current = null;
    resetUnlockDialog();
  }, [isUnlockingRemoteThreadKey, resetUnlockDialog]);

  const verifyRemoteThreadAccess = useCallback(
    async (activation: PendingRemoteThreadActivation) => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("Native API not found.");
      }

      await api.server.verifyExecutionTarget({
        executionTargetId: activation.executionTargetId,
        ...(activation.cwd ? { cwd: activation.cwd } : {}),
      });
    },
    [],
  );

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
        try {
          await verifyRemoteThreadAccess(activation);
          pendingActivationRef.current = null;
          navigateToThreadRoute(threadId);
          void reconnectRemoteThreadTerminals(activation).catch((error) => {
            toastManager.add({
              type: "error",
              title: "Failed to refresh remote terminal",
              description:
                error instanceof Error ? error.message : "An error occurred while reconnecting.",
            });
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Failed to reconnect to the remote project.";
          const lockedKeyPath = getPassphraseProtectedSshKeyPath(errorMessage);
          if (lockedKeyPath) {
            pendingActivationRef.current = activation;
            setRemoteThreadUnlockKeyPath(lockedKeyPath);
            setRemoteThreadUnlockPassphrase("");
            setRemoteThreadUnlockError(null);
            setIsRemoteThreadUnlockDialogOpen(true);
            return;
          }

          toastManager.add({
            type: "error",
            title: "Remote project unavailable",
            description: errorMessage,
          });
        }
      })();
    },
    [
      navigateToThreadRoute,
      projectCwdById,
      reconnectRemoteThreadTerminals,
      sidebarThreadsById,
      verifyRemoteThreadAccess,
    ],
  );

  const submitRemoteThreadUnlock = useCallback(async () => {
    const passphrase = remoteThreadUnlockPassphrase.trim();
    if (passphrase.length === 0) {
      setRemoteThreadUnlockError("Enter the SSH key passphrase.");
      return;
    }

    const activation = pendingActivationRef.current;
    if (!activation) {
      setRemoteThreadUnlockError(
        "Remote thread activation context was lost. Select the thread again.",
      );
      return;
    }

    const api = readNativeApi();
    if (!api) {
      setRemoteThreadUnlockError("Native API not found.");
      return;
    }

    setIsUnlockingRemoteThreadKey(true);
    setRemoteThreadUnlockError(null);
    try {
      await api.server.unlockSshKey({
        executionTargetId: activation.executionTargetId,
        passphrase,
      });
      await verifyRemoteThreadAccess(activation);
      pendingActivationRef.current = null;
      resetUnlockDialog();
      navigateToThreadRoute(activation.threadId);
      void reconnectRemoteThreadTerminals(activation).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Failed to refresh remote terminal",
          description:
            error instanceof Error ? error.message : "An error occurred while reconnecting.",
        });
      });
    } catch (error) {
      setRemoteThreadUnlockError(
        error instanceof Error ? error.message : "Failed to unlock the SSH key.",
      );
    } finally {
      setIsUnlockingRemoteThreadKey(false);
    }
  }, [
    navigateToThreadRoute,
    remoteThreadUnlockPassphrase,
    reconnectRemoteThreadTerminals,
    resetUnlockDialog,
    verifyRemoteThreadAccess,
  ]);

  return {
    navigateToThread,
    isRemoteThreadUnlockDialogOpen,
    remoteThreadUnlockKeyPath,
    remoteThreadUnlockPassphrase,
    remoteThreadUnlockError,
    isUnlockingRemoteThreadKey,
    closeRemoteThreadUnlockDialog,
    setRemoteThreadUnlockPassphrase,
    submitRemoteThreadUnlock,
  };
}
