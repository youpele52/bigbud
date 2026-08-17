import { CheckIcon, ChevronDownIcon, FolderIcon, SquarePenIcon } from "lucide-react";
import { isBuiltInChatsProject, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";

import {
  orderItemsByPreferredIds,
  resolveThreadStatusPill,
} from "~/components/sidebar/Sidebar.logic";
import {
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "~/components/sidebar/Sidebar.sort.logic";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Button } from "~/components/ui/button";
import { useCompactChatThread } from "~/hooks/useCompactChatThread";
import { useSettings } from "~/hooks/useSettings";
import type { SidebarThreadSummary } from "~/models/types";
import { useStore } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";

const RECENT_ITEM_LIMIT = 6;

export function CompactChatPicker({
  compactChat,
}: {
  compactChat: ReturnType<typeof useCompactChatThread>;
}) {
  const appSettings = useSettings();
  const projects = useStore((state) => state.projects);
  const sidebarThreadsById = useStore((state) => state.sidebarThreadsById);
  const sidebarRecentThreadIds = useStore((state) => state.sidebarRecentThreadIds);
  const threadIdsByProjectId = useStore((state) => state.threadIdsByProjectId);
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  const recentThreads = useMemo(
    () =>
      sidebarRecentThreadIds
        .map((threadId) => sidebarThreadsById[threadId])
        .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread))
        .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
        .slice(0, RECENT_ITEM_LIMIT),
    [sidebarRecentThreadIds, sidebarThreadsById],
  );
  const completedThreads = useMemo(
    () =>
      sortThreadsForSidebar(
        Object.values(sidebarThreadsById)
          .filter((thread) => thread.archivedAt === null && thread.deletingAt === null)
          .filter(
            (thread) =>
              resolveThreadStatusPill({
                thread: { ...thread, lastVisitedAt: lastVisitedAtById[thread.id] },
              })?.label === "Completed",
          ),
        appSettings.sidebarThreadSortOrder,
      ).slice(0, RECENT_ITEM_LIMIT),
    [appSettings.sidebarThreadSortOrder, lastVisitedAtById, sidebarThreadsById],
  );
  const recentProjects = useMemo(() => {
    const visibleProjects = projects.filter(
      (project) => project.deletingAt === null && !isBuiltInChatsProject(project.id),
    );
    const orderedProjects = orderItemsByPreferredIds({
      items: visibleProjects,
      preferredIds: projectOrder,
      getId: (project) => project.id,
    });
    const visibleThreads = Object.values(sidebarThreadsById).filter(
      (thread) => thread.archivedAt === null && thread.deletingAt === null,
    );
    return sortProjectsForSidebar(orderedProjects, visibleThreads, "updated_at").slice(
      0,
      RECENT_ITEM_LIMIT,
    );
  }, [projectOrder, projects, sidebarThreadsById]);

  const selectThread = (threadId: ThreadId, projectId: ProjectId) => {
    void compactChat.selectThread(threadId, projectId);
  };
  const getProjectThreads = (projectId: ProjectId) =>
    sortThreadsForSidebar(
      (threadIdsByProjectId[projectId] ?? [])
        .map((threadId) => sidebarThreadsById[threadId])
        .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread))
        .filter((thread) => thread.archivedAt === null && thread.deletingAt === null),
      appSettings.sidebarThreadSortOrder,
    );

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-2 text-muted-foreground/60 hover:text-foreground/80"
            aria-label="Choose floating chat"
            onClick={() => void compactChat.loadMoreProjects()}
          />
        }
      >
        <FolderIcon className="size-3" />
        <span className="max-w-[8rem] truncate text-xs">{compactChat.projectName}</span>
        <ChevronDownIcon className="size-3" />
        {completedThreads.length > 0 ? (
          <span
            aria-label={`${completedThreads.length} completed thread${completedThreads.length === 1 ? "" : "s"}`}
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-64">
        {completedThreads.length > 0 ? (
          <MenuGroup>
            <MenuGroupLabel className="sm:text-xs">Completed</MenuGroupLabel>
            <ThreadMenuItems
              threads={completedThreads}
              completed
              currentThreadId={compactChat.threadId}
              onSelect={selectThread}
            />
          </MenuGroup>
        ) : null}
        <MenuGroup>
          <MenuGroupLabel className="sm:text-xs">Recent threads</MenuGroupLabel>
          <ThreadMenuItems
            threads={recentThreads}
            currentThreadId={compactChat.threadId}
            onSelect={selectThread}
          />
        </MenuGroup>
        {recentProjects.length > 0 ? (
          <MenuGroup>
            <MenuSeparator />
            <MenuGroupLabel className="sm:text-xs">Projects</MenuGroupLabel>
            {recentProjects.map((project) => {
              const projectThreads = getProjectThreads(project.id);
              return (
                <MenuSub key={project.id}>
                  <MenuSubTrigger
                    inset
                    className={
                      project.id === compactChat.projectId
                        ? "text-xs text-foreground"
                        : "text-xs text-muted-foreground"
                    }
                    onClick={() => void compactChat.loadProjectThreads(project.id)}
                  >
                    <FolderIcon className="size-3 opacity-60" />
                    {project.name}
                  </MenuSubTrigger>
                  <MenuSubPopup sideOffset={-1} className="min-w-56">
                    <MenuItem
                      className="justify-start text-xs text-muted-foreground"
                      onClick={() => void compactChat.newChat(project.id)}
                    >
                      <SquarePenIcon className="size-3 opacity-60" />
                      New thread
                    </MenuItem>
                    <MenuSeparator />
                    <ThreadMenuItems
                      threads={projectThreads}
                      currentThreadId={compactChat.threadId}
                      onSelect={selectThread}
                    />
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function ThreadMenuItems({
  completed = false,
  currentThreadId,
  onSelect,
  threads,
}: {
  completed?: boolean;
  currentThreadId: ThreadId;
  onSelect: (threadId: ThreadId, projectId: ProjectId) => void;
  threads: ReadonlyArray<SidebarThreadSummary>;
}) {
  if (threads.length === 0) {
    return (
      <MenuItem disabled className="text-xs">
        No recent threads
      </MenuItem>
    );
  }

  return threads.map((thread) => (
    <MenuItem
      key={thread.id}
      disabled={thread.id === currentThreadId}
      inset
      className={
        thread.id === currentThreadId
          ? "text-xs text-foreground data-disabled:opacity-100"
          : "text-xs text-muted-foreground"
      }
      {...(thread.id === currentThreadId
        ? {}
        : { onClick: () => onSelect(thread.id, thread.projectId) })}
    >
      {completed ? <CheckIcon className="size-3 text-primary" /> : null}
      <span className="truncate">{thread.title}</span>
    </MenuItem>
  ));
}
