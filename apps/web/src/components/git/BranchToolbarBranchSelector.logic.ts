import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";

interface UseBranchListVirtualizerOptions {
  filteredBranchPickerItems: string[];
  checkoutPullRequestItemValue: string | null;
  isBranchMenuOpen: boolean;
  shouldVirtualizeBranchList: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  branchesCount: number;
  fetchNextPage: () => Promise<unknown>;
  deferredTrimmedBranchQuery: string;
}

/** Virtual list + infinite scroll pagination for the branch picker. */
export function useBranchListVirtualizer({
  filteredBranchPickerItems,
  checkoutPullRequestItemValue,
  isBranchMenuOpen,
  shouldVirtualizeBranchList,
  hasNextPage,
  isFetchingNextPage,
  branchesCount,
  fetchNextPage,
  deferredTrimmedBranchQuery,
}: UseBranchListVirtualizerOptions) {
  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);

  const maybeFetchNextBranchPage = useCallback(() => {
    if (!isBranchMenuOpen || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const distanceFromBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    if (distanceFromBottom > 96) {
      return;
    }

    void fetchNextPage().catch(() => undefined);
  }, [fetchNextPage, hasNextPage, isBranchMenuOpen, isFetchingNextPage]);

  const branchListVirtualizer = useVirtualizer({
    count: filteredBranchPickerItems.length,
    estimateSize: (index) =>
      filteredBranchPickerItems[index] === checkoutPullRequestItemValue ? 44 : 28,
    getScrollElement: () => branchListScrollElementRef.current,
    overscan: 12,
    enabled: isBranchMenuOpen && shouldVirtualizeBranchList,
    initialRect: {
      height: 224,
      width: 0,
    },
  });

  const virtualBranchRows = branchListVirtualizer.getVirtualItems();

  const setBranchListRef = useCallback(
    (element: HTMLDivElement | null) => {
      branchListScrollElementRef.current =
        (element?.parentElement as HTMLDivElement | null) ?? null;
      if (element) {
        branchListVirtualizer.measure();
      }
    },
    [branchListVirtualizer],
  );

  useEffect(() => {
    if (!isBranchMenuOpen || !shouldVirtualizeBranchList) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [
    branchListVirtualizer,
    filteredBranchPickerItems.length,
    isBranchMenuOpen,
    shouldVirtualizeBranchList,
  ]);

  useEffect(() => {
    if (!isBranchMenuOpen) {
      return;
    }

    branchListScrollElementRef.current?.scrollTo({ top: 0 });
  }, [deferredTrimmedBranchQuery, isBranchMenuOpen]);

  useEffect(() => {
    const scrollElement = branchListScrollElementRef.current;
    if (!scrollElement || !isBranchMenuOpen) {
      return;
    }

    const handleScroll = () => {
      maybeFetchNextBranchPage();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [isBranchMenuOpen, maybeFetchNextBranchPage]);

  useEffect(() => {
    maybeFetchNextBranchPage();
  }, [branchesCount, maybeFetchNextBranchPage]);

  return {
    branchListVirtualizer,
    virtualBranchRows,
    setBranchListRef,
    getTotalSize: () => branchListVirtualizer.getTotalSize(),
    scrollToIndex: (index: number, options?: { align?: "auto" | "start" | "end" | "center" }) =>
      branchListVirtualizer.scrollToIndex(index, options),
  };
}

export interface BranchPickerItemStyle extends CSSProperties {}
