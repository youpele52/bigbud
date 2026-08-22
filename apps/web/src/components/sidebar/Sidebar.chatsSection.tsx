import { Chatting01Icon, Comment03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronRightIcon, SquarePenIcon } from "lucide-react";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS, SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { type SidebarThreadSortOrder } from "@bigbud/contracts/settings";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { ChatSortMenu } from "./SidebarChatSortMenu";
import { SidebarSectionLabel } from "./SidebarSectionLabel";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SharedProjectItemProps, SidebarRenderedThreadEntry } from "./Sidebar.types";

export const RECENT_CHAT_INITIAL_VISIBLE_COUNT = 4;

interface SidebarChatsSectionProps {
  renderedChats: SidebarRenderedThreadEntry[];
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  hasMoreChats: boolean;
  collapsedHiddenChatCount: number | null;
  unloadedChatCount: number | null;
  isLoadingMoreChats: boolean;
  onLoadMoreChats: () => void;
  onNewChat: () => void;
  newThreadShortcutLabel: string | null | undefined;
  sharedProjectItemProps: SharedProjectItemProps;
  chatsSortOrder?: SidebarThreadSortOrder;
  onChatsSortOrderChange?: (sortOrder: SidebarThreadSortOrder) => void;
}

export function SidebarChatsSection({
  renderedChats,
  isExpanded,
  onExpandedChange,
  showAll,
  onShowAllChange,
  hasMoreChats,
  collapsedHiddenChatCount,
  unloadedChatCount,
  isLoadingMoreChats,
  onLoadMoreChats,
  onNewChat,
  newThreadShortcutLabel,
  sharedProjectItemProps,
  chatsSortOrder = "updated_at",
  onChatsSortOrderChange,
}: SidebarChatsSectionProps) {
  const hasHiddenChats =
    collapsedHiddenChatCount === null
      ? renderedChats.length > RECENT_CHAT_INITIAL_VISIBLE_COUNT || hasMoreChats
      : collapsedHiddenChatCount > 0;
  const visibleChats = showAll
    ? renderedChats
    : renderedChats.slice(0, RECENT_CHAT_INITIAL_VISIBLE_COUNT);
  const hiddenCount = renderedChats.length - RECENT_CHAT_INITIAL_VISIBLE_COUNT;

  return (
    <SidebarGroup className="px-2 py-2">
      <SidebarSectionLabel
        actions={
          <>
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
                <SquarePenIcon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
              </TooltipTrigger>
              <TooltipPopup side="right">
                {newThreadShortcutLabel ? `New chat (${newThreadShortcutLabel})` : "New chat"}
              </TooltipPopup>
            </Tooltip>
          </>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <HugeiconsIcon
            aria-hidden="true"
            className={SIDEBAR_ICON_SIZE_CLASS}
            icon={Chatting01Icon}
            size={14}
            strokeWidth={1.5}
          />
          Chats
        </span>
      </SidebarSectionLabel>

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
              <HugeiconsIcon
                aria-hidden="true"
                className={`${SIDEBAR_COMPACT_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70`}
                icon={Comment03Icon}
                size={12}
                strokeWidth={1.5}
              />
              <span className="truncate text-xs font-medium text-foreground/90">Recents</span>
              <ChevronRightIcon
                className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70 transition-all duration-150 ${
                  isExpanded
                    ? "translate-x-0 rotate-90 opacity-100"
                    : "translate-x-1 opacity-0 group-hover/project-header:translate-x-0 group-hover/project-header:opacity-100"
                }`}
              />
            </button>
          </SidebarMenuButton>
        </div>

        {/* Thread list - shown when expanded */}
        {isExpanded && (
          <SidebarMenuSub className="my-0 ml-2 mr-1 gap-0.5 overflow-hidden pl-3 pr-1 py-0">
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
                    branchThread={sharedProjectItemProps.branchThread}
                    favoriteThreadIds={sharedProjectItemProps.favoriteThreadIds}
                    automationThreadIds={sharedProjectItemProps.automationThreadIds}
                    toggleFavoriteThread={sharedProjectItemProps.toggleFavoriteThread}
                    requestThreadDelete={sharedProjectItemProps.requestThreadDelete}
                    openPrLink={sharedProjectItemProps.openPrLink}
                    pr={sharedProjectItemProps.prByThreadId.get(entry.threadId) ?? null}
                  />
                ))}

                {hasHiddenChats && (
                  <SidebarMenuSubItem className="w-full">
                    <SidebarMenuSubButton
                      render={<button type="button" disabled={isLoadingMoreChats} />}
                      data-thread-selection-safe
                      size="sm"
                      className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                      onClick={() => onShowAllChange(!showAll)}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span>
                          {showAll
                            ? "Show less"
                            : collapsedHiddenChatCount === null
                              ? `See more (${hiddenCount})`
                              : `See more (${collapsedHiddenChatCount})`}
                        </span>
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )}
                {showAll && hasMoreChats && (
                  <SidebarMenuSubItem className="w-full">
                    <SidebarMenuSubButton
                      render={<button type="button" disabled={isLoadingMoreChats} />}
                      data-thread-selection-safe
                      size="sm"
                      className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
                      onClick={onLoadMoreChats}
                    >
                      <span>
                        {isLoadingMoreChats
                          ? "Loading..."
                          : unloadedChatCount === null
                            ? "Load more"
                            : `Load more (${unloadedChatCount})`}
                      </span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                )}
              </>
            )}
          </SidebarMenuSub>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}
