import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
} from "lucide-react";
import { isBuiltInChatsProject, type ProjectId, type ThreadId } from "@bigbud/contracts";

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
import { sortThreadsForSidebar, truncateThreadName } from "../sidebar/Sidebar.sort.logic";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useSettings } from "../../hooks/useSettings";
import { useStore } from "../../stores/main";
import type { Project } from "../../models/types";

interface BranchToolbarProjectMenuProps {
  activeProject: Project | undefined;
}

export default function BranchToolbarProjectMenu({ activeProject }: BranchToolbarProjectMenuProps) {
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const appSettings = useSettings();
  const threadSortOrder = appSettings.sidebarThreadSortOrder;

  const recentThreads = useMemo(() => {
    if (!activeProject) return [];
    const projectThreads = threads.filter(
      (t) => t.projectId === activeProject.id && t.archivedAt === null && t.deletingAt === null,
    );
    return sortThreadsForSidebar(projectThreads, threadSortOrder).slice(0, 4);
  }, [activeProject, threads, threadSortOrder]);

  const allProjects = useMemo(() => {
    return projects.filter((p) => !isBuiltInChatsProject(p.id));
  }, [projects]);

  const handleNavigateToThread = useCallback(
    (threadId: ThreadId) => {
      void navigate({ to: "/$threadId", params: { threadId } });
    },
    [navigate],
  );

  const handleStartNewThreadForProject = useCallback(
    (projectId: ProjectId) => {
      void handleNewThread(projectId);
    },
    [handleNewThread],
  );

  if (!activeProject) return null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-2 text-muted-foreground/60 hover:text-foreground/80"
          />
        }
      >
        <FolderIcon className="size-3" />
        <span className="max-w-[8rem] truncate text-xs">{activeProject.name}</span>
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-64">
        <MenuGroup>
          <div className="flex items-center gap-2 px-2 py-1 sm:text-sm font-medium">
            {activeProject.name}
          </div>
        </MenuGroup>

        {recentThreads.length > 0 && (
          <MenuGroup>
            <MenuGroupLabel className="sm:text-xs">Recent threads</MenuGroupLabel>
            {recentThreads.map((thread) => (
              <MenuItem
                key={thread.id}
                onClick={() => handleNavigateToThread(thread.id)}
                inset
                className="sm:text-sm"
              >
                <MessageSquareIcon className="size-3 opacity-60" />
                {truncateThreadName(thread.title)}
              </MenuItem>
            ))}
          </MenuGroup>
        )}

        {allProjects.length > 0 && (
          <MenuGroup>
            <MenuSeparator />
            <MenuGroupLabel className="sm:text-xs">Projects</MenuGroupLabel>
            {allProjects.map((project) => {
              const isCurrent = project.id === activeProject.id;
              return (
                <MenuItem
                  key={project.id}
                  onClick={isCurrent ? undefined : () => handleStartNewThreadForProject(project.id)}
                  inset
                  className="sm:text-sm"
                >
                  <FolderIcon className="size-3 opacity-60" />
                  {project.name}
                  {isCurrent ? <CheckIcon className="ms-auto size-3" /> : null}
                </MenuItem>
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
