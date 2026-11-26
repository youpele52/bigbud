import { useMemo, useState } from "react";

import { reconnectRemoteThreadTerminalsInBackground } from "../../../hooks/remoteThreadTerminals";
import { useThreadRemoteTarget } from "../../../hooks/useThreadRemoteTarget";
import type { Thread } from "../../../models/types/app.types";
import { useRemoteAccessStore } from "../../../stores/remoteAccess/remoteAccess.store";
import {
  promptRemoteTargetAuth,
  reconnectRemoteTargetAccess,
} from "../../../stores/remoteAccess/remoteTargetAccess";
import { requestConnect } from "../../../stores/remoteAccess/remoteTargetActions.connection";
import { useThreadNoticeDismissal } from "../../../stores/ui/threadNoticeDismissal.store";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { ChatBanner } from "../common/ChatBanner";
import { deriveServerTurnFailure } from "./ThreadRecoveryNotice.failure";
import {
  deriveThreadRemoteTargetNotice,
  describeThreadRemoteTargetNotice,
} from "./ThreadRemoteTargetNotice.logic";
import { canResendMessage, resendUnsentMessage } from "./ThreadRemoteTargetNotice.resend";

/**
 * In-thread notice for an SSH workspace (no navigation happened, so no gate): amber when the last
 * message did not send because the target was unavailable (Reconnect / Enter password), green
 * with Resend once access is back, and the read-only banner for a user-disconnected workspace.
 * Replaces the red "Thread failed" and "Could not reconnect" cards for these failures.
 */
export function ThreadRemoteTargetNotice({
  thread,
}: {
  readonly thread: Pick<
    Thread,
    "id" | "projectId" | "messages" | "activities" | "runtimeMode" | "interactionMode"
  >;
}) {
  const target = useThreadRemoteTarget(thread.id, thread.projectId);
  const executionTargetId = target?.executionTargetId;
  const check = useRemoteAccessStore((state) =>
    executionTargetId ? state.executionTargetChecks[executionTargetId] : undefined,
  );
  const userDisconnected = useRemoteAccessStore((state) =>
    executionTargetId ? state.disconnectedExecutionTargetIds[executionTargetId] === true : false,
  );
  const { messages, activities } = thread;
  const serverFailure = useMemo(
    () => deriveServerTurnFailure({ messages, activities }),
    [messages, activities],
  );
  const failure =
    serverFailure?.remoteTarget && serverFailure.createdAt
      ? {
          remoteTarget: serverFailure.remoteTarget,
          createdAt: serverFailure.createdAt,
          detail: serverFailure.detail,
        }
      : null;
  const state = deriveThreadRemoteTargetNotice({
    isRemote: target !== null,
    userDisconnected,
    failure,
    check,
    canResend: canResendMessage(thread, serverFailure?.pendingMessageId),
  });
  const { dismissed, dismiss } = useThreadNoticeDismissal(thread.id, "remote-target", [
    state?.kind === "disconnected" ? "disconnected" : (serverFailure?.failureEventId ?? ""),
  ]);
  const [resending, setResending] = useState(false);

  if (!state || !target || dismissed) return null;
  const copy = describeThreadRemoteTargetNotice(state, target.hostLabel);
  const accessInput = {
    executionTargetId: target.executionTargetId,
    ...(target.cwd ? { cwd: target.cwd } : {}),
  };
  const onAction = () => {
    if (state.kind === "disconnected") {
      void requestConnect(target.projectId);
      return;
    }
    if (state.kind === "reconnected") {
      if (!serverFailure) return;
      setResending(true);
      void resendUnsentMessage(thread, serverFailure.pendingMessageId)
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not resend the message",
            description: error instanceof Error ? error.message : "Try sending it again.",
          });
        })
        .finally(() => setResending(false));
      return;
    }
    if (state.authMode && promptRemoteTargetAuth(accessInput)) return;
    void reconnectRemoteTargetAccess({
      ...accessInput,
      prompt: true,
      onVerified: () => reconnectRemoteThreadTerminalsInBackground(target),
    });
  };

  return (
    <ChatBanner
      variant={copy.variant}
      role="status"
      aria-live="polite"
      data-remote-target-notice={state.kind}
      title={copy.title}
      description={copy.description}
      dismissLabel="Dismiss remote workspace notice"
      onDismiss={dismiss}
      action={
        copy.actionLabel ? (
          <Button size="sm" variant="outline" disabled={resending} onClick={onAction}>
            {copy.actionLabel}
          </Button>
        ) : null
      }
    />
  );
}
