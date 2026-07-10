import { ChevronRightIcon, PinIcon } from "lucide-react";
import { SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { SidebarThreadRow } from "./SidebarThreadRow";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import type { SharedProjectItemProps, SidebarRenderedThreadEntry } from "./Sidebar.types";

export const PINNED_THREAD_INITIAL_VISIBLE_COUNT = 4;

interface SidebarFavoritesSectionProps {
  renderedFavorites: SidebarRenderedThreadEntry[];
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
  sharedProjectItemProps: SharedProjectItemProps;
  bootstrapComplete: boolean;
}

export function SidebarFavoritesSection({
  renderedFavorites,
  isExpanded,
  onExpandedChange,
  showAll,
  onShowAllChange,
  sharedProjectItemProps,
  bootstrapComplete,
}: SidebarFavoritesSectionProps) {
  const hasMoreFavorites = renderedFavorites.length > PINNED_THREAD_INITIAL_VISIBLE_COUNT;
  const visibleFavorites = showAll
    ? renderedFavorites
    : renderedFavorites.slice(0, PINNED_THREAD_INITIAL_VISIBLE_COUNT);
  const hiddenCount = renderedFavorites.length - PINNED_THREAD_INITIAL_VISIBLE_COUNT;

  return (
    <SidebarGroup className="px-2 py-2">
      {!bootstrapComplete ? (
        <div className="flex justify-center px-2 pt-6">
          <Spinner className={`${SIDEBAR_ICON_SIZE_CLASS} text-muted-foreground/40`} />
        </div>
      ) : (
        <SidebarMenu>
          <div className="group/project-header relative">
            <SidebarMenuButton
              render={<div />}
              size="sm"
              className="gap-2 px-2 py-1.5 pt-3 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
              onClick={() => onExpandedChange(!isExpanded)}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 touch-pan-y items-center gap-2 text-left"
              >
                <PinIcon
                  className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 rotate-45 text-muted-foreground/70`}
                />
                <span className="truncate text-xs font-medium text-foreground/90">Pinned</span>
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

          {isExpanded ? (
            <SidebarMenuSub className="my-0 ml-2 mr-1 gap-0.5 overflow-hidden pl-3 pr-1 py-0">
              {renderedFavorites.length === 0 ? (
                <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
                  <span>No pinned threads yet</span>
                </div>
              ) : (
                <>
                  {visibleFavorites.map((entry) => (
                    <SidebarThreadRow
                      key={`favorite-${entry.threadId}`}
                      threadId={entry.threadId}
                      orderedProjectThreadIds={entry.orderedThreadIds}
                      routeThreadId={sharedProjectItemProps.routeThreadId}
                      selectedThreadIds={sharedProjectItemProps.selectedThreadIds}
                      showThreadJumpHints={false}
                      jumpLabel={null}
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
                      requestThreadDelete={sharedProjectItemProps.requestThreadDelete}
                      openPrLink={sharedProjectItemProps.openPrLink}
                      pr={sharedProjectItemProps.prByThreadId.get(entry.threadId) ?? null}
                      favoriteThreadIds={sharedProjectItemProps.favoriteThreadIds}
                      automationThreadIds={sharedProjectItemProps.automationThreadIds}
                      toggleFavoriteThread={sharedProjectItemProps.toggleFavoriteThread}
                    />
                  ))}

                  {hasMoreFavorites ? (
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
                  ) : null}
                </>
              )}
            </SidebarMenuSub>
          ) : null}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
