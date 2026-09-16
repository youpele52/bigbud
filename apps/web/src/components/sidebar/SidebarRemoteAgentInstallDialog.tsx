import { useEffect, useState } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import type { SidebarRemoteAgentInstallRequest } from "./Sidebar.projectAddActions.remote.types";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
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
        completeRemoteAgentAdmission(request.executionTargetId, admissionRequestId);
        setConnectionRequestId(null);
        await onInstalled(
          `Connected to remote agent ${connected.currentVersion}. Healthy fallback: ${connected.fallbackVersion ?? "none"}.`,
        );
        return;
      }
      const result = await api.server.installRemoteAgent({
        executionTargetId: request.executionTargetId,
      });
      setStagedMessage(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to install the remote agent.");
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
                  The update starts only when you choose Connect new session. Reloads, reconnects
                  and retries do not activate it.
                </p>
                <p>
                  The agent is installed under <code>~/.bigbud/agent</code>, runs with your SSH user
                  permissions, and opens no inbound network port.
                </p>
                <p>
                  Choose No to cancel setup. The remote agent will not be changed and the remote
                  project will not be created or updated.
                </p>
                {error ? <p className="text-destructive">{error}</p> : null}
              </div>
            }
            cancelLabel={stagedMessage ? "Later" : "Cancel"}
            confirmLabel={
              isInstalling
                ? stagedMessage
                  ? "Connecting..."
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
