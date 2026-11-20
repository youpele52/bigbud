import { useState } from "react";

import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { Checkbox } from "../ui/checkbox";
import type { RemoteAgentHost } from "./RemoteAgentManagementSection.logic";

interface RemoteAgentRemoveDialogProps {
  readonly host: RemoteAgentHost | null;
  readonly onCancel: () => void;
  readonly onConfirm: (host: RemoteAgentHost, switchWorkspacesToDirectSsh: boolean) => void;
}

/** Confirms Remove agent, listing the affected workspaces with the Direct SSH switch on. */
export function RemoteAgentRemoveDialog({
  host,
  onCancel,
  onConfirm,
}: RemoteAgentRemoveDialogProps) {
  // The parent keys this dialog by host, so every opening starts with the switch on.
  const [switchToDirectSsh, setSwitchToDirectSsh] = useState(true);
  const agentWorkspaces = host?.transport === "agent" ? host.projects : [];
  return (
    <AlertDialog open={host !== null} onOpenChange={(open) => (!open ? onCancel() : undefined)}>
      <AlertDialogPopup className="max-w-md p-0" bottomStickOnMobile={false}>
        {host ? (
          <ConfirmationPanel
            title={`Remove the remote agent from ${host.hostLabel}?`}
            description=""
            descriptionSlot={
              <div className="space-y-2">
                <p>
                  This deletes ~/.bigbud/agent on the host and disconnects it. If live work still
                  uses the agent, nothing is removed and the work is listed. ~/.bigbud/backend-*
                  stays untouched.
                </p>
                {agentWorkspaces.length > 0 ? (
                  <>
                    <p>Workspaces on this host:</p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {agentWorkspaces.map((project) => (
                        <li key={project.id}>{project.name}</li>
                      ))}
                    </ul>
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <Checkbox
                        checked={switchToDirectSsh}
                        onCheckedChange={(checked) => setSwitchToDirectSsh(checked === true)}
                        aria-label="Switch these workspaces to Direct SSH"
                      />
                      Switch these workspaces to Direct SSH
                    </label>
                  </>
                ) : (
                  <p>No workspace uses the remote agent on this host.</p>
                )}
                <p>Reconnect over SSH or the remote agent afterwards.</p>
              </div>
            }
            cancelLabel="Cancel"
            confirmLabel="Remove agent"
            confirmVariant="destructive"
            onCancel={onCancel}
            onConfirm={() => onConfirm(host, agentWorkspaces.length > 0 && switchToDirectSsh)}
          />
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
