import { useNavigate } from "@tanstack/react-router";
import { isElectron } from "../../config/env";
import { ConfirmationPanel } from "../common/ConfirmationPanel";
import { SettingsSidebarNav } from "../settings/SettingsSidebarNav";
import { AlertDialog, AlertDialogPopup } from "../ui/alert-dialog";
import {
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { SettingsIcon } from "lucide-react";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarAppHeader } from "./SidebarHeader";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { SidebarFavoritesSection } from "./Sidebar.favoritesSection";
import { SidebarSearchSection } from "./Sidebar.searchSection";
import { SidebarChatsSection } from "./Sidebar.chatsSection";
import { SidebarProjectsSection } from "./Sidebar.projectsSection";
import { SidebarRemoteProjectDialog } from "./SidebarRemoteProjectDialog";
import { SidebarUnlockSshKeyDialog } from "./SidebarUnlockSshKeyDialog";
import { useSidebarState } from "./Sidebar.state";
import { useRemoteExecutionAccessGate } from "../../hooks/useRemoteExecutionAccessGate";

export default function Sidebar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const s = useSidebarState();
  const remoteExecutionAccess = useRemoteExecutionAccessGate();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <SidebarAppHeader />

      {s.isOnSettings ? (
        <SettingsSidebarNav pathname={s.pathname} />
      ) : (
        <>
          <SidebarSearchSection />

          <SidebarContent className="gap-0">
            <SidebarFavoritesSection
              renderedFavorites={s.renderedFavorites}
              isExpanded={s.areFavouritesExpanded}
              onExpandedChange={s.setAreFavouritesExpanded}
              sharedProjectItemProps={s.sharedProjectItemProps}
              bootstrapComplete={s.bootstrapComplete}
            />

            <SidebarChatsSection
              renderedChats={s.renderedChats}
              isExpanded={s.areChatsExpanded}
              onExpandedChange={s.setAreChatsExpanded}
              showAll={s.showAllChats}
              onShowAllChange={s.setShowAllChats}
              onNewChat={() => {
                closeMobileSidebar();
                void s.handleNewChat();
              }}
              newThreadShortcutLabel={s.newThreadShortcutLabel}
              sharedProjectItemProps={s.sharedProjectItemProps}
              chatsSortOrder={s.appSettings.sidebarChatsSortOrder}
              onChatsSortOrderChange={(sortOrder) => {
                s.updateSettings({ sidebarChatsSortOrder: sortOrder });
              }}
              bootstrapComplete={s.bootstrapComplete}
            />

            <SidebarProjectsSection
              showArm64IntelBuildWarning={s.showArm64IntelBuildWarning}
              arm64IntelBuildWarningDescription={s.arm64IntelBuildWarningDescription}
              desktopUpdateButton={{
                action: s.desktopUpdateButtonAction,
                disabled: s.desktopUpdateButtonDisabled,
                onClick: s.handleDesktopUpdateButtonClick,
              }}
              appSettingsSidebarProjectSortOrder={s.appSettings.sidebarProjectSortOrder}
              appSettingsSidebarThreadSortOrder={s.appSettings.sidebarThreadSortOrder}
              onProjectSortOrderChange={(sortOrder) => {
                s.updateSettings({ sidebarProjectSortOrder: sortOrder });
              }}
              onThreadSortOrderChange={(sortOrder) => {
                s.updateSettings({ sidebarThreadSortOrder: sortOrder });
              }}
              shouldShowProjectPathEntry={s.shouldShowProjectPathEntry}
              handleStartAddProject={s.handleStartAddProject}
              openRemoteProjectDialog={s.openRemoteProjectDialog}
              onCloseMobileSidebar={closeMobileSidebar}
              isElectron={isElectron}
              newCwd={s.newCwd}
              isPickingFolder={s.isPickingFolder}
              isAddingProject={s.isAddingProject}
              addProjectError={s.addProjectError}
              addProjectInputRef={s.addProjectInputRef}
              onCwdChange={s.setNewCwd}
              onClearError={() => s.setAddProjectError(null)}
              onPickFolder={() => void s.handlePickFolder()}
              onAdd={s.handleAddProject}
              onCancelAdd={s.cancelAddProject}
              renderedProjects={s.renderedProjects}
              isManualProjectSorting={s.isManualProjectSorting}
              bootstrapComplete={s.bootstrapComplete}
              onDragStart={s.handleProjectDragStart}
              onDragEnd={s.handleProjectDragEnd}
              onDragCancel={s.handleProjectDragCancel}
              sharedProjectItemProps={s.sharedProjectItemProps}
            />
          </SidebarContent>

          <SidebarSeparator />
          <SidebarFooter className="p-2">
            <SidebarUpdatePill />
            <SidebarMenu>
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
          </SidebarFooter>

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
                  confirmLabel="Delete"
                  confirmVariant="destructive"
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
                  title={`Delete project "${s.pendingProjectDeleteConfirmation.projectName}"?`}
                  description={
                    s.pendingProjectDeleteConfirmation.threadCount > 0
                      ? `This project has ${s.pendingProjectDeleteConfirmation.threadCount} ${s.pendingProjectDeleteConfirmation.threadCount === 1 ? "thread" : "threads"} that will also be deleted. This only removes the project from bigbud, not from your system.`
                      : "This only removes the project from bigbud, not from your system."
                  }
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

          <SidebarRemoteProjectDialog
            open={s.isRemoteProjectDialogOpen}
            draft={s.remoteProjectDraft}
            fieldErrors={s.remoteProjectFieldErrors}
            error={s.remoteProjectError}
            verificationMessage={s.remoteProjectVerificationMessage}
            isSubmitting={s.isAddingProject}
            isVerifying={s.isVerifyingRemoteProject}
            onOpenChange={(open) => {
              if (!open) {
                s.closeRemoteProjectDialog();
              }
            }}
            onFieldChange={s.updateRemoteProjectDraft}
            onSubmit={() => {
              void s.submitRemoteProjectDialog();
            }}
          />

          <SidebarUnlockSshKeyDialog
            open={s.isRemoteProjectUnlockDialogOpen}
            keyPath={s.remoteProjectUnlockKeyPath}
            title={
              s.remoteProjectUnlockMode === "password" ? "Enter SSH password" : "Unlock SSH key"
            }
            fieldLabel={
              s.remoteProjectUnlockMode === "password" ? "SSH password" : "Key passphrase"
            }
            placeholder={
              s.remoteProjectUnlockMode === "password"
                ? "Enter the SSH password"
                : "Enter the SSH key passphrase"
            }
            submitLabel={s.remoteProjectUnlockMode === "password" ? "Continue" : "Unlock SSH key"}
            description={
              s.remoteProjectUnlockMode === "password" ? (
                <>
                  BigBud needs the SSH password for <code>{s.remoteProjectUnlockKeyPath}</code>{" "}
                  before it can verify and add this remote project.
                </>
              ) : (
                <>
                  BigBud needs the passphrase for <code>{s.remoteProjectUnlockKeyPath}</code> before
                  it can verify and add this remote project.
                </>
              )
            }
            secret={s.remoteProjectUnlockPassphrase}
            error={s.remoteProjectUnlockError}
            isSubmitting={s.isUnlockingRemoteProjectKey}
            onOpenChange={(open) => {
              if (!open) {
                s.closeRemoteProjectUnlockDialog();
              }
            }}
            onSecretChange={s.setRemoteProjectUnlockPassphrase}
            onSubmit={() => {
              void s.submitRemoteProjectUnlock();
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
                  BigBud needs the SSH password for{" "}
                  <code>{remoteExecutionAccess.remoteExecutionAuthPromptLabel}</code> before it can
                  access this remote project.
                </>
              ) : (
                <>
                  BigBud needs the passphrase for{" "}
                  <code>{remoteExecutionAccess.remoteExecutionAuthPromptLabel}</code> before it can
                  access this remote project.
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
