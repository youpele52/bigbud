import { useEffect, useState } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import type { SidebarRemoteAgentInstallRequest } from "./Sidebar.projectAddActions.remote.types";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { REMOTE_AGENT_FAILURE_GUIDANCE } from "./SidebarRemoteAgentStatus.messages";
import {
  notifyRemoteAgentConnection,
  remoteAgentConnectionWarning,
} from "./SidebarRemoteAgentConnection.notifications";
import {
  completeRemoteAgentAdmission,
  getRemoteAgentAdmissionRequestId,
} from "../../stores/remoteAccess/remoteAgentAdmissionRequest";

interface SidebarRemoteAgentInstallDialogProps {
  readonly request: SidebarRemoteAgentInstallRequest | null;
  readonly onDecline: () => void;
  readonly onInstalled: (message: string) => Promise<void>;
}

export function SidebarRemoteAgentInstallDialog({
  request,
  onDecline,
  onInstalled,
}: SidebarRemoteAgentInstallDialogProps) {
  const [isInstalling, setIsInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stagedMessage, setStagedMessage] = useState<string | null>(null);
  const [connectionRequestId, setConnectionRequestId] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setStagedMessage(null);
    setConnectionRequestId(null);
  }, [request]);

  const install = async () => {
    if (!request || isInstalling) return;
    const api = readNativeApi();
    if (!api) {
      setError("Native API not found.");
      return;
    }
    setIsInstalling(true);
    setError(null);
    try {
      if (stagedMessage) {
        const admissionRequestId =
          connectionRequestId ?? getRemoteAgentAdmissionRequestId(request.executionTargetId);
        setConnectionRequestId(admissionRequestId);
        const connected = await api.server.connectRemoteAgent({
          executionTargetId: request.executionTargetId,
          requestId: admissionRequestId,
          intent: "fresh",
        });
        useRemoteAccessStore
          .getState()
          .recordRemoteConnection(request.executionTargetId, connected);
        notifyRemoteAgentConnection(request.executionTargetId, connected);
        completeRemoteAgentAdmission(request.executionTargetId, admissionRequestId);
        setConnectionRequestId(null);
        await onInstalled(
          remoteAgentConnectionWarning(connected) ??
            `Connected to remote agent ${connected.currentVersion}. Healthy fallback: ${connected.fallbackVersion ?? "none"}.`,
        );
        return;
      }
      const result = await api.server.installRemoteAgent({
        executionTargetId: request.executionTargetId,
      });
      setStagedMessage(result.message);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : stagedMessage
            ? "Failed to prepare and connect the remote agent."
            : "Failed to install the remote agent.",
      );
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !isInstalling) onDecline();
      }}
    >
      <AlertDialogPopup className="max-w-md p-0" bottomStickOnMobile={false}>
        {request ? (
          <ConfirmationPanel
            title={stagedMessage ? "Remote agent update staged" : "Download remote agent update"}
            description=""
            descriptionSlot={
              <div className="space-y-2">
                <p>
                  {stagedMessage ??
                    `Download a verified agent for ${request.targetLabel}. Existing connections remain on their current runtime.`}
                </p>
                <p>
                  The downloaded agent may be prepared in the background. Connect new session checks
                  for the latest compatible agent and verifies it before connecting. Existing
                  sessions keep their original runtime.
                </p>
                <p>
                  The agent is installed under <code>~/.bigbud/agent</code>, runs with your SSH user
                  permissions, and opens no inbound network port.
                </p>
                <p>
                  Cancel setup to leave the project unchanged. Downloaded agent builds stay
                  available for a later connection.
                </p>
                {error ? (
                  <div role="alert" className="space-y-2 text-destructive">
                    <p>{error}</p>
                    {!error.includes("Direct SSH") ? <p>{REMOTE_AGENT_FAILURE_GUIDANCE}</p> : null}
                  </div>
                ) : null}
              </div>
            }
            cancelLabel={stagedMessage ? "Later" : "Cancel"}
            confirmLabel={
              isInstalling
                ? stagedMessage
                  ? "Preparing and connecting..."
                  : "Downloading..."
                : stagedMessage
                  ? "Connect new session"
                  : "Download update"
            }
            busy={isInstalling}
            onCancel={onDecline}
            onConfirm={() => void install()}
          />
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
