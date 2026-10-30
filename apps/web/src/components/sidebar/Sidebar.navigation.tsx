import { useNavigate } from "@tanstack/react-router";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@bigbud/contracts/settings";
import { isElectron } from "../../config/env";
import { useSidebar, SidebarContent } from "../ui/sidebar";
import { BigbudLogo } from "./SidebarProjectItem";
import { SidebarActionsSection, SidebarFixedActions } from "./Sidebar.actionsSection";
import { SidebarFavoritesSection } from "./Sidebar.favoritesSection";
import { SidebarChatsSection } from "./Sidebar.chatsSection";
import { SidebarProjectsSection } from "./Sidebar.projectsSection";
import { useSidebarState } from "./Sidebar.state";
import { useItutuStore } from "../../stores/itutu/itutu.store";
import { SidebarItutuArrangementSwitch } from "./Sidebar.itutuArrangementSwitch";
import { SidebarItutuSection } from "./Sidebar.itutuSection";
import type { SidebarTopLevelHeaderProps } from "./SidebarSectionLabel";

export function SidebarNavigation({ state: s }: { state: ReturnType<typeof useSidebarState> }) {
  const navigate = useNavigate();
  const isItutu = useItutuStore((store) => store.arrangement === "itutu");
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };
  const handleNewChat = () => {
    closeMobileSidebar();
    void s.handleNewChat();
  };

  const projectProps = {
    showArm64IntelBuildWarning: s.showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription: s.arm64IntelBuildWarningDescription,
    desktopUpdateButton: {
      action: s.desktopUpdateButtonAction,
      disabled: s.desktopUpdateButtonDisabled,
      onClick: s.handleDesktopUpdateButtonClick,
    },
    appSettingsSidebarProjectSortOrder: s.appSettings.sidebarProjectSortOrder,
    appSettingsSidebarThreadSortOrder: s.appSettings.sidebarThreadSortOrder,
    onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => {
      s.updateSettings({ sidebarProjectSortOrder: sortOrder });
    },
    onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => {
      s.updateSettings({ sidebarThreadSortOrder: sortOrder });
    },
    shouldShowProjectPathEntry: s.shouldShowProjectPathEntry,
    handleStartAddProject: s.handleStartAddProject,
    openRemoteWorkspaceDialog: s.openRemoteWorkspaceDialog,
    onCloseMobileSidebar: closeMobileSidebar,
    isElectron,
    newCwd: s.newCwd,
    isPickingFolder: s.isPickingFolder,
    isAddingProject: s.isAddingProject,
    addProjectError: s.addProjectError,
    addProjectInputRef: s.addProjectInputRef,
    onCwdChange: s.setNewCwd,
    onClearError: () => s.setAddProjectError(null),
    onPickFolder: () => void s.handlePickFolder(),
    onAdd: s.handleAddProject,
    onCancelAdd: s.cancelAddProject,
    renderedProjects: s.renderedProjects,
    isExpanded: s.areProjectsExpanded,
    onExpandedChange: s.setAreProjectsExpanded,
    isRemoteWorkspacesExpanded: s.areRemoteWorkspacesExpanded,
    onRemoteWorkspacesExpandedChange: s.setAreRemoteWorkspacesExpanded,
    isManualProjectSorting: s.isManualProjectSorting,
    onDragStart: s.handleProjectDragStart,
    onDragEnd: s.handleProjectDragEnd,
    onDragCancel: s.handleProjectDragCancel,
    sharedProjectItemProps: s.sharedProjectItemProps,
  };

  // Both arrangements keep New chat and Search; only Projects shows the other actions and sections.
  const sections =
    s.bootstrapComplete && !isItutu
      ? {
          pinned: (headerProps: SidebarTopLevelHeaderProps) => (
            <SidebarFavoritesSection
              headerProps={headerProps}
              renderedFavorites={s.renderedFavorites}
              isExpanded={s.areFavouritesExpanded}
              onExpandedChange={s.setAreFavouritesExpanded}
              showAll={s.showAllFavourites}
              onShowAllChange={s.setShowAllFavourites}
              sharedProjectItemProps={s.sharedProjectItemProps}
            />
          ),
          chats: (headerProps: SidebarTopLevelHeaderProps) => (
            <SidebarChatsSection
              headerProps={headerProps}
              renderedChats={s.renderedChats}
              isExpanded={s.areChatsExpanded}
              onExpandedChange={s.setAreChatsExpanded}
              showAll={s.showAllChats}
              onShowAllChange={(showAll) => {
                s.setShowAllChats(showAll);
                if (showAll) s.loadMoreChats();
              }}
              hasMoreChats={s.hasMoreChats}
              collapsedHiddenChatCount={s.collapsedHiddenChatCount}
              unloadedChatCount={s.unloadedChatCount}
              isLoadingMoreChats={s.isLoadingMoreChats}
              onLoadMoreChats={s.loadMoreChats}
              onNewChat={handleNewChat}
              newThreadShortcutLabel={s.newThreadShortcutLabel}
              sharedProjectItemProps={s.sharedProjectItemProps}
              chatsSortOrder={s.appSettings.sidebarChatsSortOrder}
              onChatsSortOrderChange={(sortOrder) => {
                s.updateSettings({ sidebarChatsSortOrder: sortOrder });
              }}
            />
          ),
          projects: (headerProps: SidebarTopLevelHeaderProps) => (
            <SidebarProjectsSection {...projectProps} scope="local" headerProps={headerProps} />
          ),
          "remote-workspaces": (headerProps: SidebarTopLevelHeaderProps) => (
            <SidebarProjectsSection {...projectProps} scope="remote" headerProps={headerProps} />
          ),
        }
      : {};

  return (
    <>
      <SidebarContent className="min-h-full gap-0">
        <SidebarItutuArrangementSwitch />
        {isItutu ? (
          <div className="py-2">
            <SidebarFixedActions
              onNewChat={handleNewChat}
              newThreadShortcutLabel={s.newThreadShortcutLabel}
            />
          </div>
        ) : (
          <SidebarActionsSection
            onNewChat={handleNewChat}
            newThreadShortcutLabel={s.newThreadShortcutLabel}
            onOpenAutomations={() => {
              closeMobileSidebar();
              void navigate({ to: "/automations" });
            }}
            onOpenGames={() => {
              closeMobileSidebar();
              void navigate({ to: "/games" });
            }}
            onOpenUsage={() => {
              closeMobileSidebar();
              void navigate({ to: "/usage" });
            }}
            onOpenSystemMonitor={() => {
              closeMobileSidebar();
              void navigate({ to: "/system-monitor" });
            }}
            sections={sections}
          />
        )}
        {s.bootstrapComplete && isItutu ? (
          <SidebarItutuSection shared={s.sharedProjectItemProps} />
        ) : null}
        {!s.bootstrapComplete ? (
          <div className="flex flex-1 items-center justify-center">
            <BigbudLogo className="size-4 animate-breathe text-muted-foreground/40 motion-reduce:animate-none" />
          </div>
        ) : null}
      </SidebarContent>
    </>
  );
}
