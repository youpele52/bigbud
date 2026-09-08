import { CheckIcon, ChevronDownIcon, SquarePenIcon } from "lucide-react";
import { BUILT_IN_CHATS_PROJECT_ID, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useMemo } from "react";

import {
  getComposerPickerChatRecents,
  getComposerPickerProjects,
  getComposerPickerProjectThreads,
} from "~/components/project/ComposerProjectPicker.logic";
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
import { ProjectLocationIcon } from "~/components/project/ProjectLocationIcon";

const PROJECT_ITEM_LIMIT = 6;
const compactPickerItemClassName = "min-h-7 py-1 text-xs sm:min-h-7";

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
  const recentThreads = useMemo(
    () =>
      getComposerPickerChatRecents({
        loadedChatThreadIds: threadIdsByProjectId[BUILT_IN_CHATS_PROJECT_ID] ?? [],
        sidebarRecentThreadIds,
        sidebarThreadsById,
        sortOrder: appSettings.sidebarThreadSortOrder,
      }),
    [
      appSettings.sidebarThreadSortOrder,
      sidebarRecentThreadIds,
      sidebarThreadsById,
      threadIdsByProjectId,
    ],
  );
  const recentProjects = useMemo(() => {
    return getComposerPickerProjects({
      projectOrder,
      projects,
      sidebarThreadsById,
      sortOrder: appSettings.sidebarProjectSortOrder,
    }).slice(0, PROJECT_ITEM_LIMIT);
  }, [appSettings.sidebarProjectSortOrder, projectOrder, projects, sidebarThreadsById]);

  const selectThread = (threadId: ThreadId, projectId: ProjectId) => {
    void compactChat.selectThread(threadId, projectId);
  };
  const getProjectThreads = (projectId: ProjectId) =>
    getComposerPickerProjectThreads({
      projectId,
      sidebarThreadsById,
      threadIdsByProjectId,
      sortOrder: appSettings.sidebarThreadSortOrder,
    });

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
        <ProjectLocationIcon
          className="size-3"
          project={projects.find((project) => project.id === compactChat.projectId)}
        />
        <span className="max-w-[8rem] truncate text-xs">{compactChat.projectName}</span>
        <ChevronDownIcon className="size-3" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-64">
        <MenuGroup>
          <MenuGroupLabel className="sm:text-xs">Recents</MenuGroupLabel>
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
                    className={cn(
                      compactPickerItemClassName,
                      project.id === compactChat.projectId
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                    onClick={() => void compactChat.loadProjectThreads(project.id)}
                  >
                    <span className="inline-flex w-2.5 shrink-0 items-center justify-center">
                      {project.id === compactChat.projectId ? (
                        <CheckIcon className="size-3" />
                      ) : null}
                    </span>
                    <ProjectLocationIcon
                      className={cn("size-3", project.id !== compactChat.projectId && "opacity-60")}
                      project={project}
                    />
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
  onSelect,
  threads,
}: {
  currentThreadId: ThreadId;
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
    return (
      <MenuItem
        key={thread.id}
        disabled={thread.id === currentThreadId}
        className={cn(
          compactPickerItemClassName,
          thread.id === currentThreadId
            ? "text-foreground data-disabled:opacity-100"
            : "text-muted-foreground",
        )}
        {...(thread.id === currentThreadId
          ? {}
          : { onClick: () => onSelect(thread.id, thread.projectId) })}
      >
        <span className="inline-flex w-2.5 shrink-0 items-center justify-center">
          {thread.id === currentThreadId ? <CheckIcon className="size-3" /> : null}
        </span>
        <span className="min-w-0 truncate">{thread.title}</span>
      </MenuItem>
    );
  });
}
