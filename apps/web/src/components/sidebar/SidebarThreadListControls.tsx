import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

interface SidebarThreadListControlsProps {
  hasHiddenThreads: boolean;
  hasMoreThreads: boolean;
  collapsedHiddenCount: number | null;
  unloadedCount: number | null;
  isExpanded: boolean;
  isLoading: boolean;
  loadError?: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onLoadMore: () => void;
}

const controlClassName =
  "h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80";

/** Shared project/Inyosira preview and paging controls. Counts never substitute zero for unknown. */
export function SidebarThreadListControls({
  hasHiddenThreads,
  hasMoreThreads,
  collapsedHiddenCount,
  unloadedCount,
  isExpanded,
  isLoading,
  loadError = false,
  onExpandedChange,
  onLoadMore,
}: SidebarThreadListControlsProps) {
  return (
    <>
      {hasHiddenThreads ? (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={<button type="button" disabled={isLoading} />}
            data-thread-selection-safe
            size="sm"
            className={controlClassName}
            onClick={() => onExpandedChange(!isExpanded)}
          >
            <span>
              {isExpanded
                ? "Show less"
                : collapsedHiddenCount === null
                  ? "See more"
                  : `See more (${collapsedHiddenCount})`}
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {(isExpanded && hasMoreThreads) || loadError ? (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={<button type="button" disabled={isLoading} />}
            data-thread-selection-safe
            size="sm"
            className={controlClassName}
            onClick={onLoadMore}
          >
            <span>
              {isLoading
                ? "Loading..."
                : loadError
                  ? "Couldn't load threads. Try again"
                  : unloadedCount === null
                    ? "Load more"
                    : `Load more (${unloadedCount})`}
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </>
  );
}
