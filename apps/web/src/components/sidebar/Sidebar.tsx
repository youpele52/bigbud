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
import { SidebarFavoritesSection } from "./Sidebar.favoritesSection";
import { SidebarSearchSection } from "./Sidebar.searchSection";
import { SidebarChatsSection } from "./Sidebar.chatsSection";
import { SidebarProjectsSection } from "./Sidebar.projectsSection";
import { SidebarRemoteProjectDialog } from "./SidebarRemoteProjectDialog";
import { SidebarUnlockSshKeyDialog } from "./SidebarUnlockSshKeyDialog";
import { useSidebarState } from "./Sidebar.state";

export default function Sidebar() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const s = useSidebarState();
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
                  <SettingsIcon className="size-3.5" />
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
            description={
              <>
                BigBud needs the passphrase for <code>{s.remoteProjectUnlockKeyPath}</code> before
                it can verify and add this remote project.
              </>
            }
            passphrase={s.remoteProjectUnlockPassphrase}
            error={s.remoteProjectUnlockError}
            isSubmitting={s.isUnlockingRemoteProjectKey}
            onOpenChange={(open) => {
              if (!open) {
                s.closeRemoteProjectUnlockDialog();
              }
            }}
            onPassphraseChange={s.setRemoteProjectUnlockPassphrase}
            onSubmit={() => {
              void s.submitRemoteProjectUnlock();
            }}
          />

          <SidebarUnlockSshKeyDialog
            open={s.isRemoteThreadUnlockDialogOpen}
            keyPath={s.remoteThreadUnlockKeyPath}
            description={
              <>
                BigBud needs the passphrase for <code>{s.remoteThreadUnlockKeyPath}</code> before it
                can reconnect to this remote project.
              </>
            }
            passphrase={s.remoteThreadUnlockPassphrase}
            error={s.remoteThreadUnlockError}
            isSubmitting={s.isUnlockingRemoteThreadKey}
            onOpenChange={(open) => {
              if (!open) {
                s.closeRemoteThreadUnlockDialog();
              }
            }}
            onPassphraseChange={s.setRemoteThreadUnlockPassphrase}
            onSubmit={() => {
              void s.submitRemoteThreadUnlock();
            }}
          />
        </>
      )}
    </>
  );
}
