import { projectDeleteConfirmationCopy } from "./Sidebar.projectActions.delete.copy";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import { SidebarSeparator } from "../ui/sidebar";
import { SidebarAppHeader } from "./SidebarHeader";
import { SidebarFooterBar } from "./Sidebar.footer";
import { SidebarNavigation } from "./Sidebar.navigation";
import { SidebarRemoteWorkspaceDialog } from "./SidebarRemoteWorkspaceDialog";
import { SidebarProjectEditDialog } from "./SidebarProjectEditDialog";
import { SidebarUnlockSshKeyDialog } from "./SidebarUnlockSshKeyDialog";
import { SidebarInyosiraSnoozeDialog } from "./Sidebar.inyosiraSnoozeDialog";
import { useSidebarState } from "./Sidebar.state";

export default function Sidebar() {
  const s = useSidebarState();

  return (
    <>
      <SidebarAppHeader />
      <SidebarProjectEditDialog />

      {s.isOnSettings ? (
        <SettingsSidebarNav pathname={s.pathname} />
      ) : (
        <>
          <SidebarNavigation state={s} />

          <SidebarSeparator />
          <SidebarFooterBar />

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
            agentInstallProgress={s.remoteAgentInstallProgress}
            manualInstallTarget={s.remoteAgentManualInstallTarget}
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

          <SidebarInyosiraSnoozeDialog />

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
        </>
      )}
    </>
  );
}
