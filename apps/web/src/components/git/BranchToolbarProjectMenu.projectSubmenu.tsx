import type { ThreadId } from "@bigbud/contracts";
import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { Project, SidebarThreadSummary } from "../../models/types";
import {
  runRemoteTargetMenuAction,
  useRemoteTargetMenuItems,
} from "../../stores/remoteAccess/remoteTargetActions.menu";
import { NewChatIcon } from "../common/NewChatIcon";
import { ProjectLocationIcon } from "../project/ProjectLocationIcon";
import { truncateThreadName } from "../sidebar/Sidebar.sort.logic";
import { MenuItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger } from "../ui/menu";

const SUBMENU_ITEM_CLASS = "min-h-7 py-1 text-xs sm:min-h-7";

/**
 * One workspace in the composer picker: New thread, its threads, and for an SSH workspace the
 * workspace menu's connection controls after the threads (same shared actions and dialogs).
 */
export function BranchToolbarProjectSubmenu({
  project,
  isCurrent,
  activeThreadId,
  threads,
  onNewThread,
  onNavigateToThread,
}: {
  readonly project: Project;
  readonly isCurrent: boolean;
  readonly activeThreadId: ThreadId | undefined;
  readonly threads: readonly Pick<SidebarThreadSummary, "id" | "title">[];
  readonly onNewThread: () => void;
  readonly onNavigateToThread: (threadId: ThreadId) => void;
}) {
  const remoteItems = useRemoteTargetMenuItems(project);
  return (
    <MenuSub>
      <MenuSubTrigger
        className={cn(SUBMENU_ITEM_CLASS, isCurrent ? "text-foreground" : "text-muted-foreground")}
      >
        <span className="inline-flex w-2.5 shrink-0 items-center justify-center">
          {isCurrent ? <CheckIcon className="size-3" /> : null}
        </span>
        <ProjectLocationIcon
          className={cn("size-3", !isCurrent && "opacity-60")}
          project={project}
        />
        {project.name}
      </MenuSubTrigger>
      <MenuSubPopup sideOffset={-1} className="min-w-56">
        <MenuItem
          className={`${SUBMENU_ITEM_CLASS} justify-start text-muted-foreground`}
          onClick={onNewThread}
        >
          <NewChatIcon className="size-3 opacity-60" />
          New thread
        </MenuItem>
        <MenuSeparator />
        {threads.length > 0 ? (
          threads.map((thread) => {
            const isThreadCurrent = thread.id === activeThreadId;
            return (
              <MenuItem
                key={thread.id}
                onClick={() => onNavigateToThread(thread.id)}
                className={cn(
                  SUBMENU_ITEM_CLASS,
                  isThreadCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <span className="inline-flex w-2.5 shrink-0 items-center justify-center">
                  {isThreadCurrent ? <CheckIcon className="size-3" /> : null}
                </span>
                <span className="min-w-0 truncate">{truncateThreadName(thread.title)}</span>
              </MenuItem>
            );
          })
        ) : (
          <MenuItem disabled className={SUBMENU_ITEM_CLASS}>
            No recent threads
          </MenuItem>
        )}
        {remoteItems.length > 0 ? (
          <>
            <MenuSeparator />
            {remoteItems.map((item) => (
              <MenuItem
                key={item.id}
                disabled={item.disabled === true}
                className={`${SUBMENU_ITEM_CLASS} text-muted-foreground`}
                onClick={() => void runRemoteTargetMenuAction(item.id, project.id)}
              >
                <span className="inline-flex w-2.5 shrink-0" />
                {item.label}
              </MenuItem>
            ))}
          </>
        ) : null}
      </MenuSubPopup>
    </MenuSub>
  );
}
