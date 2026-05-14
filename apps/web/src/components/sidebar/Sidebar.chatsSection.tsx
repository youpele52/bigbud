import {
  ChevronRightIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  SquarePenIcon,
} from "lucide-react";
import { type SidebarThreadSortOrder } from "@bigbud/contracts/settings";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { ChatSortMenu } from "./SidebarChatSortMenu";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SharedProjectItemProps, SidebarRenderedThreadEntry } from "./Sidebar.types";

export const RECENT_CHAT_INITIAL_VISIBLE_COUNT = 5;

const SIDEBAR_SECTION_ICON_SIZE = "size-4";

interface SidebarChatsSectionProps {
  renderedChats: SidebarRenderedThreadEntry[];
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  onNewChat: () => void;
  newThreadShortcutLabel: string | null | undefined;
  sharedProjectItemProps: SharedProjectItemProps;
  chatsSortOrder?: SidebarThreadSortOrder;
  onChatsSortOrderChange?: (sortOrder: SidebarThreadSortOrder) => void;
  bootstrapComplete: boolean;
}

export function SidebarChatsSection({
  renderedChats,
  isExpanded,
  onExpandedChange,
  showAll,
  onShowAllChange,
  onNewChat,
  newThreadShortcutLabel,
  sharedProjectItemProps,
  chatsSortOrder = "updated_at",
  onChatsSortOrderChange,
  bootstrapComplete,
}: SidebarChatsSectionProps) {
  const hasMoreChats = renderedChats.length > RECENT_CHAT_INITIAL_VISIBLE_COUNT;
  const visibleChats = showAll
    ? renderedChats
    : renderedChats.slice(0, RECENT_CHAT_INITIAL_VISIBLE_COUNT);
  const hiddenCount = renderedChats.length - RECENT_CHAT_INITIAL_VISIBLE_COUNT;

  return (
    <SidebarGroup className="px-2 py-2">
      {/* Header with label, sort controls, and add button */}
      <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Chats
        </span>
        <div className="flex items-center gap-1">
          {onChatsSortOrderChange && (
            <ChatSortMenu
              chatsSortOrder={chatsSortOrder}
              onChatsSortOrderChange={onChatsSortOrderChange}
            />
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New chat"
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  onClick={onNewChat}
                />
              }
            >
              <SquarePenIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">
              {newThreadShortcutLabel ? `New chat (${newThreadShortcutLabel})` : "New chat"}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>

      {/* Loading spinner - shown during bootstrap */}
      {!bootstrapComplete && (
        <div className="flex justify-center px-2 pt-6">
          <Spinner className="size-4 text-muted-foreground/40" />
        </div>
      )}

      {/* Collapsible Chats folder - hidden during loading */}
      {bootstrapComplete && (
        <SidebarMenu>
          <div className="group/project-header relative">
            <SidebarMenuButton
              render={<div />}
              size="sm"
              className="gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
              onClick={() => onExpandedChange(!isExpanded)}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 touch-pan-y items-center gap-2 text-left"
              >
                <ChevronRightIcon
                  className={`-ml-0.5 ${SIDEBAR_SECTION_ICON_SIZE} shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                    isExpanded ? "rotate-90" : ""
                  }`}
                />
                {isExpanded ? (
                  <MessageSquareTextIcon
                    className={`${SIDEBAR_SECTION_ICON_SIZE} shrink-0 text-muted-foreground/70`}
                  />
                ) : (
                  <MessageSquareIcon
                    className={`${SIDEBAR_SECTION_ICON_SIZE} shrink-0 text-muted-foreground/70`}
                  />
                )}
                <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                  Recents
                </span>
              </button>
            </SidebarMenuButton>
          </div>

          {/* Thread list - shown when expanded */}
          {isExpanded && (
            <SidebarMenuSub className="my-0 ml-3 mr-1 translate-x-px gap-0.5 overflow-hidden border-l border-sidebar-border pl-6 pr-1 py-0">
              {renderedChats.length === 0 ? (
                <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
                  <span>No chats yet</span>
                </div>
              ) : (
                <>
                  {visibleChats.map((entry) => (
                    <SidebarThreadRow
                      key={entry.threadId}
                      threadId={entry.threadId}
                      orderedProjectThreadIds={entry.orderedThreadIds}
                      routeThreadId={sharedProjectItemProps.routeThreadId}
                      selectedThreadIds={sharedProjectItemProps.selectedThreadIds}
                      showThreadJumpHints={sharedProjectItemProps.showThreadJumpHints}
                      jumpLabel={
                        sharedProjectItemProps.threadJumpLabelById.get(entry.threadId) ?? null
                      }
                      renamingThreadId={sharedProjectItemProps.renamingThreadId}
                      renamingTitle={sharedProjectItemProps.renamingTitle}
                      setRenamingTitle={sharedProjectItemProps.setRenamingTitle}
                      onRenamingInputMount={sharedProjectItemProps.onRenamingInputMount}
                      hasRenameCommitted={sharedProjectItemProps.hasRenameCommitted}
                      markRenameCommitted={sharedProjectItemProps.markRenameCommitted}
                      handleThreadClick={sharedProjectItemProps.handleThreadClick}
                      navigateToThread={sharedProjectItemProps.navigateToThread}
                      handleMultiSelectContextMenu={
                        sharedProjectItemProps.handleMultiSelectContextMenu
                      }
                      handleThreadContextMenu={sharedProjectItemProps.handleThreadContextMenu}
                      clearSelection={sharedProjectItemProps.clearSelection}
                      commitRename={sharedProjectItemProps.commitRename}
                      cancelRename={sharedProjectItemProps.cancelRename}
                      forkThread={sharedProjectItemProps.forkThread}
                      favoriteThreadIds={sharedProjectItemProps.favoriteThreadIds}
                      toggleFavoriteThread={sharedProjectItemProps.toggleFavoriteThread}
                      requestThreadDelete={sharedProjectItemProps.requestThreadDelete}
                      openPrLink={sharedProjectItemProps.openPrLink}
                      pr={sharedProjectItemProps.prByThreadId.get(entry.threadId) ?? null}
                    />
                  ))}

                  {/* See more / Show less button */}
                  {hasMoreChats && (
                    <SidebarMenuSubItem className="w-full">
                      <SidebarMenuSubButton
                        render={<button type="button" />}
                        data-thread-selection-safe
                        size="sm"
                        className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                        onClick={() => onShowAllChange(!showAll)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2">
                          <span>{showAll ? "Show less" : `See more (${hiddenCount})`}</span>
                        </span>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )}
                </>
              )}
            </SidebarMenuSub>
          )}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
