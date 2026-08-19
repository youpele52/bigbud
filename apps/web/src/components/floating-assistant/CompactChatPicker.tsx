import { ChevronDownIcon, FolderIcon, SquarePenIcon } from "lucide-react";
import {
  BUILT_IN_CHATS_PROJECT_ID,
  isBuiltInChatsProject,
  type ProjectId,
  type ThreadId,
} from "@bigbud/contracts";
import { useMemo } from "react";

import {
  orderItemsByPreferredIds,
  resolveThreadStatusPill,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "~/components/sidebar/Sidebar.logic";
import { collectVisibleChatThreads } from "~/components/sidebar/Sidebar.state.visibleThreads";
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
import { cn } from "~/lib/utils";
import { useStore } from "~/stores/main";
import { useUiStateStore } from "~/stores/ui";

const RECENT_ITEM_LIMIT = 6;
const compactPickerItemClassName = "min-h-6 py-0 text-xs sm:min-h-6";

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
      sortThreadsForSidebar(
        collectVisibleChatThreads({
          loadedChatThreadIds: threadIdsByProjectId[BUILT_IN_CHATS_PROJECT_ID] ?? [],
          sidebarRecentThreadIds,
          sidebarThreadsById,
        }),
        appSettings.sidebarThreadSortOrder,
      ).slice(0, RECENT_ITEM_LIMIT),
    [
      appSettings.sidebarThreadSortOrder,
      sidebarRecentThreadIds,
      sidebarThreadsById,
      threadIdsByProjectId,
    ],
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
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel className="sm:text-xs">Recent threads</MenuGroupLabel>
          <ThreadMenuItems
            lastVisitedAtById={lastVisitedAtById}
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
                    className={cn(
                      compactPickerItemClassName,
                      project.id === compactChat.projectId
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                    onClick={() => void compactChat.loadProjectThreads(project.id)}
                  >
                    <FolderIcon className="size-3 opacity-60" />
                    {project.name}
                  </MenuSubTrigger>
                  <MenuSubPopup sideOffset={-1} className="min-w-56">
                    <MenuItem
                      className={cn(
                        "justify-start text-muted-foreground",
                        compactPickerItemClassName,
                      )}
                      onClick={() => void compactChat.newChat(project.id)}
                    >
                      <SquarePenIcon className="size-3 opacity-60" />
                      New thread
                    </MenuItem>
                    <MenuSeparator />
                    <ThreadMenuItems
                      lastVisitedAtById={lastVisitedAtById}
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
  currentThreadId,
  lastVisitedAtById,
  onSelect,
  threads,
}: {
  currentThreadId: ThreadId;
  lastVisitedAtById: Record<string, string>;
  onSelect: (threadId: ThreadId, projectId: ProjectId) => void;
  threads: ReadonlyArray<SidebarThreadSummary>;
}) {
  if (threads.length === 0) {
    return (
      <MenuItem disabled className={compactPickerItemClassName}>
        No recent threads
      </MenuItem>
    );
  }

  return threads.map((thread) => {
    const status = resolveThreadStatusPill({
      thread: { ...thread, lastVisitedAt: lastVisitedAtById[thread.id] },
    });

    return (
      <MenuItem
        key={thread.id}
        disabled={thread.id === currentThreadId}
        className={cn(
          "grid grid-cols-[1rem_1fr]",
          compactPickerItemClassName,
          thread.id === currentThreadId
            ? "text-foreground data-disabled:opacity-100"
            : "text-muted-foreground",
        )}
        {...(thread.id === currentThreadId
          ? {}
          : { onClick: () => onSelect(thread.id, thread.projectId) })}
      >
        <span className="col-start-1 flex size-3 items-center justify-center">
          {status ? (
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${
                status.label === "Completed" ? "bg-success" : status.dotClass
              } ${status.pulse ? "animate-pulse" : ""}`}
            />
          ) : null}
        </span>
        <span className="col-start-2 min-w-0 truncate">{thread.title}</span>
      </MenuItem>
    );
  });
}
