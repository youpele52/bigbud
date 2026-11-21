import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, FolderPlusIcon } from "lucide-react";
import { BUILT_IN_CHATS_PROJECT_ID, type ProjectId, type ThreadId } from "@bigbud/contracts";

import {
  getComposerPickerChatRecents,
  getComposerPickerProjects,
  getComposerPickerProjectThreads,
} from "../project/ComposerProjectPicker.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { startSidebarAddProjectFlow } from "../sidebar/SidebarAddProjectBridge";
import { truncateThreadName } from "../sidebar/Sidebar.sort.logic";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import type { Project } from "../../models/types";
import { ProjectLocationIcon } from "../project/ProjectLocationIcon";
import { BranchToolbarProjectSubmenu } from "./BranchToolbarProjectMenu.projectSubmenu";

interface BranchToolbarProjectMenuProps {
  activeProject: Project | undefined;
  activeThreadId: ThreadId | undefined;
}

export default function BranchToolbarProjectMenu({
  activeProject,
  activeThreadId,
}: BranchToolbarProjectMenuProps) {
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const projects = useStore((store) => store.projects);
  const sidebarThreadsById = useStore((store) => store.sidebarThreadsById);
  const sidebarRecentThreadIds = useStore((store) => store.sidebarRecentThreadIds);
  const threadIdsByProjectId = useStore((store) => store.threadIdsByProjectId);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const appSettings = useSettings();
  const threadSortOrder = appSettings.sidebarThreadSortOrder;

  const recentThreads = useMemo(
    () =>
      getComposerPickerChatRecents({
        loadedChatThreadIds: threadIdsByProjectId[BUILT_IN_CHATS_PROJECT_ID] ?? [],
        sidebarRecentThreadIds,
        sidebarThreadsById,
        sortOrder: threadSortOrder,
      }),
    [sidebarRecentThreadIds, sidebarThreadsById, threadIdsByProjectId, threadSortOrder],
  );

  const allProjects = useMemo(
    () =>
      getComposerPickerProjects({
        projectOrder,
        projects,
        sidebarThreadsById,
        sortOrder: appSettings.sidebarProjectSortOrder,
      }),
    [appSettings.sidebarProjectSortOrder, projectOrder, projects, sidebarThreadsById],
  );

  const handleNavigateToThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  const getProjectThreads = (projectId: ProjectId) =>
    getComposerPickerProjectThreads({
      projectId,
      sidebarThreadsById,
      threadIdsByProjectId,
      sortOrder: threadSortOrder,
    });

  if (!activeProject) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="max-w-full min-w-0 gap-2 text-muted-foreground/60 hover:text-foreground/80"
          />
        }
      >
        <ProjectLocationIcon className="size-3" project={activeProject} />
        <span className="min-w-0 max-w-[8rem] truncate text-xs">{activeProject.name}</span>
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-64">
        {recentThreads.length > 0 && (
          <MenuGroup>
            <MenuGroupLabel className="sm:text-xs">Recents</MenuGroupLabel>
            {recentThreads.map((thread) => {
              const isCurrent = thread.id === activeThreadId;
              return (
                <MenuItem
                  key={thread.id}
                  onClick={() => handleNavigateToThread(thread.id)}
                  className={isCurrent ? "text-[11px]" : "text-[11px] text-muted-foreground"}
                >
                  <span className="inline-flex w-2.5 shrink-0 items-center justify-center">
                    {isCurrent ? <CheckIcon className="size-3" /> : null}
                  </span>
                  {truncateThreadName(thread.title)}
                </MenuItem>
              );
            })}
          </MenuGroup>
        )}

        {allProjects.length > 0 && (
          <MenuGroup>
            <MenuSeparator />
            <MenuGroupLabel className="sm:text-xs">Projects</MenuGroupLabel>
            {allProjects.map((project) => {
              const isCurrent = project.id === activeProject.id;
              const projectThreads = getProjectThreads(project.id);
              return (
                <BranchToolbarProjectSubmenu
                  key={project.id}
                  project={project}
                  isCurrent={isCurrent}
                  activeThreadId={activeThreadId}
                  threads={projectThreads}
                  onNewThread={() => void handleNewThread(project.id)}
                  onNavigateToThread={handleNavigateToThread}
                />
              );
            })}
          </MenuGroup>
        )}

        <MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={startSidebarAddProjectFlow} inset className="sm:text-sm">
            <FolderPlusIcon className="size-3 opacity-60" />
            Add new project
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
