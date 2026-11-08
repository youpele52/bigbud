import { SIDEBAR_THREAD_PREVIEW_LIMIT } from "../../constants/sidebar";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";

interface SidebarThreadListControlsProps {
  hasHiddenThreads: boolean;
  hasMoreThreads: boolean;
  collapsedHiddenCount: number | null;
  unloadedCount: number | null;
  /** Loaded threads the collapsed preview hides; shown before another page is fetched. */
  hiddenLoadedCount: number;
  isExpanded: boolean;
  isLoading: boolean;
  loadError?: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onLoadMore: () => void;
}

const controlClassName =
  "h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80";

/** One server page, or fewer when an authoritative count says so. Unknown counts stay at 4. */
export function resolveShowMoreCount(remaining: number | null): number {
  return remaining === null
    ? SIDEBAR_THREAD_PREVIEW_LIMIT
    : Math.max(1, Math.min(SIDEBAR_THREAD_PREVIEW_LIMIT, remaining));
}

/** What "Show more" does next: reveal loaded rows the preview hides, or fetch the next page. */
export function resolveShowMoreAction(input: {
  readonly isExpanded: boolean;
  readonly hasHiddenThreads: boolean;
  readonly hasMoreThreads: boolean;
  readonly hiddenLoadedCount: number;
  readonly collapsedHiddenCount: number | null;
  readonly unloadedCount: number | null;
}): { readonly kind: "none" } | { readonly kind: "reveal" | "fetch"; readonly count: number } {
  if (!input.isExpanded && input.hiddenLoadedCount > 0) {
    return { kind: "reveal", count: input.hiddenLoadedCount };
  }
  if (input.hasMoreThreads) {
    const remaining = input.isExpanded ? input.unloadedCount : input.collapsedHiddenCount;
    return { kind: "fetch", count: resolveShowMoreCount(remaining) };
  }
  if (!input.isExpanded && input.hasHiddenThreads) {
    return { kind: "reveal", count: resolveShowMoreCount(input.collapsedHiddenCount) };
  }
  return { kind: "none" };
}

/**
 * Shared project/Inyosira paging controls. A list shows one 4-thread page; "Show 4 more" fetches
 * the next server page in the displayed order instead of revealing a hidden larger page. Counts
 * never substitute zero for unknown.
 */
export function SidebarThreadListControls({
  hasHiddenThreads,
  hasMoreThreads,
  collapsedHiddenCount,
  unloadedCount,
  hiddenLoadedCount,
  isExpanded,
  isLoading,
  loadError = false,
  onExpandedChange,
  onLoadMore,
}: SidebarThreadListControlsProps) {
  const action = resolveShowMoreAction({
    isExpanded,
    hasHiddenThreads,
    hasMoreThreads,
    hiddenLoadedCount,
    collapsedHiddenCount,
    unloadedCount,
  });
  const showMore = () => {
    if (!isExpanded) onExpandedChange(true);
    if (loadError || action.kind === "fetch") onLoadMore();
  };
  return (
    <>
      {action.kind !== "none" || loadError ? (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={<button type="button" disabled={isLoading} />}
            data-thread-selection-safe
            size="sm"
            className={controlClassName}
            onClick={showMore}
          >
            <span>
              {isLoading
                ? "Loading..."
                : loadError
                  ? "Couldn't load threads. Try again"
                  : action.kind === "none"
                    ? "Show more"
                    : `Show ${action.count} more`}
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
      {isExpanded && hasHiddenThreads ? (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={<button type="button" disabled={isLoading} />}
            data-thread-selection-safe
            size="sm"
            className={controlClassName}
            onClick={() => onExpandedChange(false)}
          >
            <span>Show less</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ) : null}
    </>
  );
}
