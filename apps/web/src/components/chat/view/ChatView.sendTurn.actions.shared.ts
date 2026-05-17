import { resolveWorkspaceExecutionTargetId } from "../../../lib/providerExecutionTargets";
import type { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";

import { getWorktreeValidationError, resolveSendContext } from "./ChatView.sendTurn.helpers";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

export function isCurrentComposerDraftEmpty(input: {
  promptRef: UseOnSendInput["promptRef"];
  composerImagesRef: UseOnSendInput["composerImagesRef"];
  composerFilesRef: UseOnSendInput["composerFilesRef"];
  composerAnnotationsRef: UseOnSendInput["composerAnnotationsRef"];
  composerTerminalContextsRef: UseOnSendInput["composerTerminalContextsRef"];
}) {
  return (
    input.promptRef.current.length === 0 &&
    input.composerImagesRef.current.length === 0 &&
    input.composerFilesRef.current.length === 0 &&
    input.composerAnnotationsRef.current.length === 0 &&
    input.composerTerminalContextsRef.current.length === 0
  );
}

export async function persistThreadSettingsForNextTurnIfServer(input: {
  isServer: boolean;
  persistThreadSettingsForNextTurn: UseOnSendInput["persistThreadSettingsForNextTurn"];
  params: Parameters<UseOnSendInput["persistThreadSettingsForNextTurn"]>[0];
}) {
  if (!input.isServer) {
    return;
  }

  await input.persistThreadSettingsForNextTurn(input.params);
}

export async function prepareSendContext(input: {
  input: UseOnSendInput;
  onSend: () => Promise<void>;
  ensureRemoteExecutionTargetAccess: ReturnType<
    typeof useRemoteExecutionAccessGate
  >["ensureRemoteExecutionTargetAccess"];
}) {
  const {
    activeProject: project,
    activeThread: thread,
    isServerThread: isServer,
    envMode,
  } = input.input;
  if (!thread || !project) {
    return null;
  }

  const sendContext = resolveSendContext({ thread, isServer, envMode });
  const worktreeValidationError = getWorktreeValidationError({
    shouldCreateWorktree: sendContext.shouldCreateWorktree,
    thread,
    project,
  });
  if (worktreeValidationError) {
    input.input.setStoreThreadError(sendContext.threadIdForSend, worktreeValidationError);
    return null;
  }

  const remoteCwd = thread.worktreePath ?? project.cwd;
  const remoteReady = await input.ensureRemoteExecutionTargetAccess({
    executionTargetId:
      thread.workspaceExecutionTargetId !== undefined || thread.executionTargetId !== undefined
        ? resolveWorkspaceExecutionTargetId(thread)
        : resolveWorkspaceExecutionTargetId(project),
    ...(remoteCwd ? { cwd: remoteCwd } : {}),
    onVerified: () => input.onSend(),
    resumeOnUnlockOnly: true,
  });
  if (!remoteReady) {
    return null;
  }

  return sendContext;
}
