import { useEffect, useState } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";

interface RemoteAgentInstallRequest {
  readonly executionTargetId: string;
  readonly targetLabel: string;
}

interface SidebarRemoteAgentInstallDialogProps {
  readonly request: RemoteAgentInstallRequest | null;
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

  useEffect(() => {
    setError(null);
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
      const result = await api.server.installRemoteAgent({
        executionTargetId: request.executionTargetId,
      });
      await onInstalled(result.message);
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
            title="Install the bigbud remote agent?"
            description=""
            descriptionSlot={
              <div className="space-y-2">
                <p>
                  bigbud needs to install its remote agent for{" "}
                  <strong>{request.targetLabel}</strong> before this remote project can be created
                  or updated.
                </p>
                <p>
                  The agent is installed under <code>~/.bigbud/agent</code>, runs with your SSH user
                  permissions, and opens no inbound network port.
                </p>
                <p>
                  Choose No to cancel setup. Nothing will be installed and the remote project will
                  not be created.
                </p>
                {error ? <p className="text-destructive">{error}</p> : null}
              </div>
            }
            cancelLabel="No, cancel setup"
            confirmLabel={
              isInstalling ? "Installing..." : error ? "Retry installation" : "Yes, install agent"
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
