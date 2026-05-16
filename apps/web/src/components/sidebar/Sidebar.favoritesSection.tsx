import { ChevronRightIcon, PinIcon } from "lucide-react";
import { SIDEBAR_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { SidebarThreadRow } from "./SidebarThreadRow";
import { SidebarSectionLabel } from "./SidebarSectionLabel";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuSub } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import type { SharedProjectItemProps, SidebarRenderedThreadEntry } from "./Sidebar.types";

interface SidebarFavoritesSectionProps {
  renderedFavorites: SidebarRenderedThreadEntry[];
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  sharedProjectItemProps: SharedProjectItemProps;
  bootstrapComplete: boolean;
}

export function SidebarFavoritesSection({
  renderedFavorites,
  isExpanded,
  onExpandedChange,
  sharedProjectItemProps,
  bootstrapComplete,
}: SidebarFavoritesSectionProps) {
  return (
    <SidebarGroup className="px-2 py-2">
      <SidebarSectionLabel>Favourites</SidebarSectionLabel>

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
              className="gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
              onClick={() => onExpandedChange(!isExpanded)}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 touch-pan-y items-center gap-2 text-left"
              >
                <ChevronRightIcon
                  className={`-ml-0.5 ${SIDEBAR_ICON_SIZE_CLASS} shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                    isExpanded ? "rotate-90" : ""
                  }`}
                />
                <PinIcon
                  className={`${SIDEBAR_ICON_SIZE_CLASS} shrink-0 rotate-45 text-muted-foreground/70`}
                />
                <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                  Pinned
                </span>
              </button>
            </SidebarMenuButton>
          </div>

          {isExpanded ? (
            <SidebarMenuSub className="my-0 ml-3 mr-1 translate-x-px gap-0.5 overflow-hidden border-l border-sidebar-border pl-6 pr-1 py-0">
              {renderedFavorites.length === 0 ? (
                <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
                  <span>No pinned threads yet</span>
                </div>
              ) : (
                renderedFavorites.map((entry) => (
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
                    forkThread={sharedProjectItemProps.forkThread}
                    requestThreadDelete={sharedProjectItemProps.requestThreadDelete}
                    openPrLink={sharedProjectItemProps.openPrLink}
                    pr={sharedProjectItemProps.prByThreadId.get(entry.threadId) ?? null}
                    favoriteThreadIds={sharedProjectItemProps.favoriteThreadIds}
                    toggleFavoriteThread={sharedProjectItemProps.toggleFavoriteThread}
                  />
                ))
              )}
            </SidebarMenuSub>
          ) : null}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
