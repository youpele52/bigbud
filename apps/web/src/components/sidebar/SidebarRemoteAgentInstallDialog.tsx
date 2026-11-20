import { useEffect, useState } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import type { SidebarRemoteAgentInstallRequest } from "./Sidebar.remoteWorkspaceAddActions.types";
import { REMOTE_AGENT_FAILURE_GUIDANCE } from "./SidebarRemoteAgentStatus.messages";
import { SidebarRemoteAgentManualInstall } from "./SidebarRemoteAgentManualInstall";
import { remoteAgentConnectionWarning } from "./SidebarRemoteAgentConnection.notifications";
import { connectFreshRemoteAgent } from "./Sidebar.remoteWorkspaceAgentInstall";

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
  const [manualOpen, setManualOpen] = useState(false);

  useEffect(() => {
    setError(null);
    setStagedMessage(null);
    setManualOpen(false);
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
        // Older builds are retired once the staged build is active (deferred for live work).
        const connected = await connectFreshRemoteAgent(api, request.executionTargetId);
        const connectedMessage =
          remoteAgentConnectionWarning(connected) ??
          `Connected to remote agent ${connected.currentVersion}. Backup version: ${connected.fallbackVersion ?? "none"}.`;
        await onInstalled(
          connected.cleanupMessage
            ? `${connectedMessage} ${connected.cleanupMessage}`
            : connectedMessage,
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
                  The agent is installed under{" "}
                  <span className="font-light">&quot;~/.bigbud/agent&quot;</span>, runs with your
                  SSH user permissions, and opens no inbound network port.
                </p>
                <p>
                  After the new build is active, older agent builds are removed. Builds still used
                  by open sessions stay until that work ends.
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
                {stagedMessage ? null : (
                  <SidebarRemoteAgentManualInstall
                    executionTargetId={request.executionTargetId}
                    autoOpen={error !== null && !error.includes("Direct SSH")}
                    onOpenChange={setManualOpen}
                  />
                )}
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
                  : manualOpen
                    ? "Finish install"
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
