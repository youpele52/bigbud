import { useNavigate } from "@tanstack/react-router";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@bigbud/contracts/settings";
import { isElectron } from "../../config/env";
import { useSidebar, SidebarContent } from "../ui/sidebar";
import { BigbudLogo } from "./SidebarProjectItem";
import { SidebarActionsSection } from "./Sidebar.actionsSection";
import { SidebarFavoritesSection } from "./Sidebar.favoritesSection";
import { SidebarChatsSection } from "./Sidebar.chatsSection";
import { SidebarProjectsSection } from "./Sidebar.projectsSection";
import { useSidebarState } from "./Sidebar.state";
import type { SidebarTopLevelHeaderProps } from "./SidebarSectionLabel";

export function SidebarNavigation({ state: s }: { state: ReturnType<typeof useSidebarState> }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
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
    openRemoteProjectDialog: s.openRemoteProjectDialog,
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
    isRemoteProjectsExpanded: s.areRemoteProjectsExpanded,
    onRemoteProjectsExpandedChange: s.setAreRemoteProjectsExpanded,
    isManualProjectSorting: s.isManualProjectSorting,
    onDragStart: s.handleProjectDragStart,
    onDragEnd: s.handleProjectDragEnd,
    onDragCancel: s.handleProjectDragCancel,
    sharedProjectItemProps: s.sharedProjectItemProps,
  };

  const sections = s.bootstrapComplete
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
          />
        ),
        projects: (headerProps: SidebarTopLevelHeaderProps) => (
          <SidebarProjectsSection {...projectProps} scope="local" headerProps={headerProps} />
        ),
        "remote-projects": (headerProps: SidebarTopLevelHeaderProps) => (
          <SidebarProjectsSection {...projectProps} scope="remote" headerProps={headerProps} />
        ),
      }
    : {};

  return (
    <>
      <SidebarContent className="min-h-full gap-0">
        <SidebarActionsSection
          onNewChat={() => {
            closeMobileSidebar();
            void s.handleNewChat();
          }}
          newThreadShortcutLabel={s.newThreadShortcutLabel}
          onOpenAutomations={() => {
            closeMobileSidebar();
            void navigate({ to: "/automations" });
          }}
          onOpenPlugins={() => {
            closeMobileSidebar();
            void navigate({ to: "/plugins" });
          }}
          onOpenGames={() => {
            closeMobileSidebar();
            void navigate({ to: "/games" });
          }}
          onOpenUsage={() => {
            closeMobileSidebar();
            void navigate({ to: "/usage" });
          }}
          sections={sections}
        />
        {!s.bootstrapComplete ? (
          <div className="flex flex-1 items-center justify-center">
            <BigbudLogo className="size-4 animate-breathe text-muted-foreground/40 motion-reduce:animate-none" />
          </div>
        ) : null}
      </SidebarContent>
    </>
  );
}
