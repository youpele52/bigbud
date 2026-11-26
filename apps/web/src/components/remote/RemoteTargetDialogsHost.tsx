import { useEffect } from "react";

import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";
import { useStore } from "../../stores/main";
import {
  confirmDisconnect,
  dismissDisconnect,
} from "../../stores/remoteAccess/remoteTargetActions.connection";
import {
  confirmReconnect,
  dismissReconnect,
  readKnownProjectIds,
  reconcileStoredReconnectRequests,
  startReconnectReconciler,
} from "../../stores/remoteAccess/remoteTargetActions.reconnect";
import { useRemoteTargetActionsStore } from "../../stores/remoteAccess/remoteTargetActions.store";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { describeDisconnectConfirmation } from "../sidebar/Sidebar.projectActions.connection.logic";
import { SidebarUnlockSshKeyDialog } from "../sidebar/SidebarUnlockSshKeyDialog";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";

/** Runs the persisted-Reconnect reconciler once per renderer while the host is mounted. */
function useRemoteTargetReconnectReconciler() {
  const projects = useStore((state) => state.projects);
  useEffect(() => startReconnectReconciler(), []);
  useEffect(() => {
    reconcileStoredReconnectRequests(readKnownProjectIds());
  }, [projects]);
}

function RemoteExecutionAuthDialog() {
  const access = useRemoteExecutionAccessGate();
  const isPassword = access.remoteExecutionAuthMode === "password";
  return (
    <SidebarUnlockSshKeyDialog
      open={access.isRemoteExecutionAuthDialogOpen}
      keyPath={access.remoteExecutionAuthPromptLabel}
      title={isPassword ? "Enter SSH password" : "Unlock SSH key"}
      fieldLabel={isPassword ? "SSH password" : "Key passphrase"}
      placeholder={isPassword ? "Enter the SSH password" : "Enter the SSH key passphrase"}
      submitLabel={isPassword ? "Continue" : "Unlock SSH key"}
      description={
        <>
          bigbud needs the {isPassword ? "SSH password" : "passphrase"} for{" "}
          <span className="break-all font-light">
            &quot;{access.remoteExecutionAuthPromptLabel}&quot;
          </span>{" "}
          before it can access this remote workspace.
        </>
      }
      secret={access.remoteExecutionAuthSecret}
      error={access.remoteExecutionAuthError}
      isSubmitting={access.isAuthenticatingRemoteExecution}
      onOpenChange={(open) => {
        if (!open) access.closeRemoteExecutionAuthDialog();
      }}
      onSecretChange={access.setRemoteExecutionAuthSecret}
      onSubmit={() => {
        void access.submitRemoteExecutionAuth();
      }}
    />
  );
}

/**
 * Global host for the remote-target Reconnect / Disconnect confirmations and the remote
 * execution auth dialog (password, key passphrase, host trust). Mounted once, outside the mobile
 * sidebar `Sheet`, so the thread gate, thread menu and composer picker can show them too.
 */
export function RemoteTargetDialogsHost() {
  const pendingReconnect = useRemoteTargetActionsStore((state) => state.pendingReconnect);
  const pendingDisconnect = useRemoteTargetActionsStore((state) => state.pendingDisconnect);
  useRemoteTargetReconnectReconciler();

  return (
    <>
      <AlertDialog
        open={pendingReconnect !== null}
        onOpenChange={(open) => {
          if (!open) dismissReconnect();
        }}
      >
        <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
          {pendingReconnect ? (
            <ConfirmationPanel
              title={`Reconnect "${pendingReconnect.projectName}"?`}
              description="Reconnect restarts the bigbud remote service and interrupts the turns and terminals it manages, including other workspaces using this service. Saved workspace settings are kept."
              cancelLabel="Cancel"
              confirmLabel="Reconnect"
              confirmVariant="destructive"
              onCancel={dismissReconnect}
              onConfirm={() => void confirmReconnect()}
            />
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={pendingDisconnect !== null}
        onOpenChange={(open) => {
          if (!open) dismissDisconnect();
        }}
      >
        <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
          {pendingDisconnect ? (
            <ConfirmationPanel
              {...describeDisconnectConfirmation(pendingDisconnect)}
              cancelLabel="Cancel"
              confirmLabel="Disconnect"
              confirmVariant="destructive"
              onCancel={dismissDisconnect}
              onConfirm={() => void confirmDisconnect()}
            />
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>

      <RemoteExecutionAuthDialog />
    </>
  );
}
