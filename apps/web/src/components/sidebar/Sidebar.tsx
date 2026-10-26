import { projectDeleteConfirmationCopy } from "./Sidebar.projectActions.delete.copy";
import { useNavigate } from "@tanstack/react-router";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "../ui/sidebar";
import { SettingsIcon } from "lucide-react";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarHelpMenu } from "./SidebarHelpMenu";
import { SidebarAppHeader } from "./SidebarHeader";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { SidebarNavigation } from "./Sidebar.navigation";
import { SidebarRemoteWorkspaceDialog } from "./SidebarRemoteWorkspaceDialog";
import { SidebarRemoteAgentInstallDialog } from "./SidebarRemoteAgentInstallDialog";
import { SidebarUnlockSshKeyDialog } from "./SidebarUnlockSshKeyDialog";
import { useSidebarState } from "./Sidebar.state";
import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";

export default function Sidebar() {
  const navigate = useNavigate();
  const s = useSidebarState();
  const remoteExecutionAccess = useRemoteExecutionAccessGate();

  return (
    <>
      <SidebarAppHeader />

      {s.isOnSettings ? (
        <SettingsSidebarNav pathname={s.pathname} />
      ) : (
        <>
          <SidebarNavigation state={s} />

          <SidebarSeparator />
          <SidebarFooter className="p-2">
            <SidebarUpdatePill />
            <div className="flex items-center gap-1">
              <SidebarMenu className="min-w-0 flex-1">
                <SidebarMenuItem>
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                    onClick={() => void navigate({ to: "/settings" })}
                  >
                    <SettingsIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
                    <span className="text-xs">Settings</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
              <SidebarHelpMenu />
            </div>
          </SidebarFooter>

          <AlertDialog
            open={s.pendingReconnect !== null}
            onOpenChange={(open) => {
              if (!open) s.dismissReconnect();
            }}
          >
            <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
              {s.pendingReconnect ? (
                <ConfirmationPanel
                  title={`Reconnect "${s.pendingReconnect.projectName}"?`}
                  description="Reconnect restarts the bigbud remote service and interrupts the turns and terminals it manages, including other workspaces using this service. Saved workspace settings are kept."
                  cancelLabel="Cancel"
                  confirmLabel="Reconnect"
                  confirmVariant="destructive"
                  onCancel={s.dismissReconnect}
                  onConfirm={() => void s.confirmReconnect()}
                />
              ) : null}
            </AlertDialogPopup>
          </AlertDialog>

          <AlertDialog
            open={s.pendingDeleteConfirmation !== null}
            onOpenChange={(open) => {
              if (!open) {
                s.dismissPendingDeleteConfirmation();
              }
            }}
          >
            <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
              {s.pendingDeleteConfirmation ? (
                <ConfirmationPanel
                  title={s.pendingDeleteConfirmation.title}
                  description={s.pendingDeleteConfirmation.description}
                  cancelLabel="Cancel"
                  confirmLabel={
                    s.pendingDeleteConfirmation.automationId ? "View automation" : "Delete"
                  }
                  confirmVariant={
                    s.pendingDeleteConfirmation.automationId ? "default" : "destructive"
                  }
                  onCancel={s.dismissPendingDeleteConfirmation}
                  onConfirm={() => {
                    void s.confirmPendingDeleteThreads();
                  }}
                />
              ) : null}
            </AlertDialogPopup>
          </AlertDialog>

          <AlertDialog
            open={s.pendingProjectDeleteConfirmation !== null}
            onOpenChange={(open) => {
              if (!open) {
                s.dismissPendingProjectDeleteConfirmation();
              }
            }}
          >
            <AlertDialogPopup className="max-w-sm p-0" bottomStickOnMobile={false}>
              {s.pendingProjectDeleteConfirmation ? (
                <ConfirmationPanel
                  {...projectDeleteConfirmationCopy(s.pendingProjectDeleteConfirmation)}
                  cancelLabel="Cancel"
                  confirmLabel="Delete"
                  confirmVariant="destructive"
                  onCancel={s.dismissPendingProjectDeleteConfirmation}
                  onConfirm={() => {
                    void s.confirmPendingProjectDelete();
                  }}
                />
              ) : null}
            </AlertDialogPopup>
          </AlertDialog>

          <SidebarRemoteWorkspaceDialog
            mode={s.remoteWorkspaceDialogMode}
            open={s.isRemoteWorkspaceDialogOpen}
            draft={s.remoteWorkspaceDraft}
            fieldErrors={s.remoteWorkspaceFieldErrors}
            error={s.remoteWorkspaceError}
            verificationMessage={s.remoteWorkspaceVerificationMessage}
            isSubmitting={s.isAddingProject || s.isSavingRemoteWorkspace}
            isVerifying={s.isVerifyingRemoteWorkspace}
            onOpenChange={(open) => {
              if (!open) {
                s.closeRemoteWorkspaceDialog();
              }
            }}
            onFieldChange={s.updateRemoteWorkspaceDraft}
            onAdoptConnectionSource={s.adoptRemoteWorkspaceConnectionSource}
            onRequestUnlock={s.requestRemoteWorkspaceUnlock}
            onSubmit={() => {
              void s.submitRemoteWorkspaceDialog();
            }}
          />

          <SidebarRemoteAgentInstallDialog
            request={s.remoteAgentInstallRequest}
            onDecline={s.declineRemoteAgentInstall}
            onInstalled={s.completeRemoteAgentInstall}
          />

          <SidebarUnlockSshKeyDialog
            open={s.isRemoteWorkspaceUnlockDialogOpen}
            keyPath={s.remoteWorkspaceUnlockKeyPath}
            title={
              s.remoteWorkspaceUnlockMode === "password" ? "Enter SSH password" : "Unlock SSH key"
            }
            fieldLabel={
              s.remoteWorkspaceUnlockMode === "password" ? "SSH password" : "Key passphrase"
            }
            placeholder={
              s.remoteWorkspaceUnlockMode === "password"
                ? "Enter the SSH password"
                : "Enter the SSH key passphrase"
            }
            submitLabel={s.remoteWorkspaceUnlockMode === "password" ? "Continue" : "Unlock SSH key"}
            description={
              s.remoteWorkspaceUnlockMode === "password" ? (
                <>
                  bigbud needs the SSH password for{" "}
                  <span className="break-all font-light">
                    &quot;{s.remoteWorkspaceUnlockKeyPath}&quot;
                  </span>{" "}
                  before it can verify and{" "}
                  {s.remoteWorkspaceDialogMode === "edit" ? "update" : "add"} this remote workspace.
                </>
              ) : (
                <>
                  bigbud needs the passphrase for{" "}
                  <span className="break-all font-light">
                    &quot;{s.remoteWorkspaceUnlockKeyPath}&quot;
                  </span>{" "}
                  before it can verify and{" "}
                  {s.remoteWorkspaceDialogMode === "edit" ? "update" : "add"} this remote workspace.
                </>
              )
            }
            secret={s.remoteWorkspaceUnlockPassphrase}
            error={s.remoteWorkspaceUnlockError}
            isSubmitting={s.isUnlockingRemoteWorkspaceKey}
            onOpenChange={(open) => {
              if (!open) {
                s.closeRemoteWorkspaceUnlockDialog();
              }
            }}
            onSecretChange={s.setRemoteWorkspaceUnlockPassphrase}
            onSubmit={() => {
              void s.submitRemoteWorkspaceUnlock();
            }}
          />

          <SidebarUnlockSshKeyDialog
            open={remoteExecutionAccess.isRemoteExecutionAuthDialogOpen}
            keyPath={remoteExecutionAccess.remoteExecutionAuthPromptLabel}
            title={
              remoteExecutionAccess.remoteExecutionAuthMode === "password"
                ? "Enter SSH password"
                : "Unlock SSH key"
            }
            fieldLabel={
              remoteExecutionAccess.remoteExecutionAuthMode === "password"
                ? "SSH password"
                : "Key passphrase"
            }
            placeholder={
              remoteExecutionAccess.remoteExecutionAuthMode === "password"
                ? "Enter the SSH password"
                : "Enter the SSH key passphrase"
            }
            submitLabel={
              remoteExecutionAccess.remoteExecutionAuthMode === "password"
                ? "Continue"
                : "Unlock SSH key"
            }
            description={
              remoteExecutionAccess.remoteExecutionAuthMode === "password" ? (
                <>
                  bigbud needs the SSH password for{" "}
                  <span className="break-all font-light">
                    &quot;{remoteExecutionAccess.remoteExecutionAuthPromptLabel}&quot;
                  </span>{" "}
                  before it can access this remote workspace.
                </>
              ) : (
                <>
                  bigbud needs the passphrase for{" "}
                  <span className="break-all font-light">
                    &quot;{remoteExecutionAccess.remoteExecutionAuthPromptLabel}&quot;
                  </span>{" "}
                  before it can access this remote workspace.
                </>
              )
            }
            secret={remoteExecutionAccess.remoteExecutionAuthSecret}
            error={remoteExecutionAccess.remoteExecutionAuthError}
            isSubmitting={remoteExecutionAccess.isAuthenticatingRemoteExecution}
            onOpenChange={(open) => {
              if (!open) {
                remoteExecutionAccess.closeRemoteExecutionAuthDialog();
              }
            }}
            onSecretChange={remoteExecutionAccess.setRemoteExecutionAuthSecret}
            onSubmit={() => {
              void remoteExecutionAccess.submitRemoteExecutionAuth();
            }}
          />
        </>
      )}
    </>
  );
}
