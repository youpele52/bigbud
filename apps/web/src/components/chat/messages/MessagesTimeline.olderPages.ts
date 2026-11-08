import type { ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { loadOlderThreadMessages } from "~/routes/-__root.bounded-bootstrap";
import { readNativeApi } from "~/rpc/nativeApi";
import { useStore, type ThreadHydration } from "~/stores/main/main.store";

/** Distance from the top of the scroll container at which the previous page is requested. */
export const OLDER_PAGE_PREFETCH_PX = 400;
/** A landed page whose rows never re-render (all duplicates) releases its anchor after this. */
const ANCHOR_SETTLE_MS = 2_000;

export type OlderPagesStatus = "idle" | "loading" | "error" | "complete" | "unavailable";

export function resolveOlderPagesStatus(hydration: ThreadHydration | undefined): OlderPagesStatus {
  switch (hydration?.status) {
    case "loaded":
      return hydration.nextCursor === null ? "complete" : "idle";
    case "loadingOlder":
      return "loading";
    case "complete":
      return "complete";
    case "failed":
      return hydration.retry.kind === "older" ? "error" : "unavailable";
    default:
      return "unavailable";
  }
}

/**
 * Requests the previous page only when it is idle and the top is near. A scrollable timeline also
 * needs the reader to have scrolled up, so opening a thread (scrollTop 0 before the bottom snap)
 * never fetches a second page; a timeline too short to scroll fills itself page by page.
 */
export function shouldRequestOlderPage(input: {
  readonly status: OlderPagesStatus;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly userScrolledUp: boolean;
}): boolean {
  if (input.status !== "idle" || input.scrollTop > OLDER_PAGE_PREFETCH_PX) return false;
  const scrollable = input.scrollHeight > input.clientHeight + 1;
  return !scrollable || input.userScrolledUp;
}

const inFlightThreadIds = new Set<string>();

/** At most one older-page request per thread, across every mounted timeline. */
export async function requestOlderMessagePage(
  threadId: ThreadId,
  load: () => Promise<void>,
): Promise<boolean> {
  if (inFlightThreadIds.has(threadId)) return false;
  inFlightThreadIds.add(threadId);
  try {
    await load();
  } finally {
    inFlightThreadIds.delete(threadId);
  }
  return true;
}

export interface TimelineRowExtent {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export interface OlderPageAnchor {
  readonly rowId: string | null;
  readonly rowIndex: number;
  readonly offset: number;
  readonly distanceFromBottom: number;
}

/** The first row still visible at the top of the viewport, and its offset from the top. */
export function captureOlderPageAnchor(
  rows: ReadonlyArray<TimelineRowExtent>,
  scrollTop: number,
  scrollHeight: number,
): OlderPageAnchor {
  const rowIndex = rows.findIndex((row) => row.end > scrollTop);
  const row = rows[rowIndex];
  return {
    rowId: row?.id ?? null,
    rowIndex,
    offset: row ? row.start - scrollTop : 0,
    distanceFromBottom: scrollHeight - scrollTop,
  };
}

/** Puts the anchored row back at its captured offset after older rows were prepended. */
export function resolveAnchoredScrollTop(
  anchor: OlderPageAnchor,
  rows: ReadonlyArray<TimelineRowExtent>,
  scrollHeight: number,
): number {
  const row = anchor.rowId === null ? undefined : rows.find((entry) => entry.id === anchor.rowId);
  const next = row ? row.start - anchor.offset : scrollHeight - anchor.distanceFromBottom;
  return Math.max(0, next);
}

const ANCHOR_CORRECTION_FRAMES = 12;

function readRowDomOffset(container: HTMLElement, rowId: string): number | null {
  const row = container.querySelector(`[data-timeline-row-id="${CSS.escape(rowId)}"]`);
  return row ? row.getBoundingClientRect().top - container.getBoundingClientRect().top : null;
}

/**
 * Prepended rows render at estimated heights first and are measured a frame later. For a few
 * frames this pulls the anchored row back to its captured on-screen offset; any wheel, touch or
 * key input hands control back to the reader immediately.
 */
function correctAnchorDrift(container: HTMLElement, rowId: string, domOffset: number) {
  let remaining = ANCHOR_CORRECTION_FRAMES;
  let frameId = 0;
  const stop = () => {
    window.cancelAnimationFrame(frameId);
    for (const type of ["wheel", "touchstart", "keydown"] as const) {
      container.removeEventListener(type, stop);
    }
  };
  const step = () => {
    const offset = readRowDomOffset(container, rowId);
    if (offset !== null && Math.abs(offset - domOffset) >= 1) {
      container.scrollTop += offset - domOffset;
    }
    remaining -= 1;
    if (remaining > 0) frameId = window.requestAnimationFrame(step);
    else stop();
  };
  for (const type of ["wheel", "touchstart", "keydown"] as const) {
    container.addEventListener(type, stop, { passive: true, once: true });
  }
  frameId = window.requestAnimationFrame(step);
  return stop;
}

/**
 * Loads 15 older messages when the reader reaches the top, one request at a time, and keeps the
 * first visible row steady while the page is prepended.
 */
export function useOlderMessagePages(input: {
  readonly threadId: ThreadId | null;
  readonly scrollContainer: HTMLElement | null;
  readonly rowIds: ReadonlyArray<string>;
  readonly readRowExtents: () => ReadonlyArray<TimelineRowExtent>;
}) {
  const { threadId, scrollContainer, rowIds, readRowExtents } = input;
  const hydration = useStore((state) =>
    threadId ? state.threadHydrationById[threadId] : undefined,
  );
  const status = threadId ? resolveOlderPagesStatus(hydration) : "unavailable";
  const statusRef = useRef(status);
  statusRef.current = status;
  const anchorRef = useRef<{
    anchor: OlderPageAnchor;
    domOffset: number | null;
    settledAt: number | null;
  } | null>(null);
  const stopCorrectionRef = useRef<(() => void) | null>(null);
  const userScrolledUpRef = useRef(false);
  const readRowExtentsRef = useRef(readRowExtents);
  readRowExtentsRef.current = readRowExtents;

  const loadOlder = useCallback(() => {
    const api = readNativeApi();
    if (!api || !threadId || !scrollContainer) return;
    const anchor = captureOlderPageAnchor(
      readRowExtentsRef.current(),
      scrollContainer.scrollTop,
      scrollContainer.scrollHeight,
    );
    anchorRef.current = {
      anchor,
      domOffset: anchor.rowId === null ? null : readRowDomOffset(scrollContainer, anchor.rowId),
      settledAt: null,
    };
    void requestOlderMessagePage(threadId, () => loadOlderThreadMessages({ api, threadId }));
  }, [scrollContainer, threadId]);

  const evaluate = useCallback(() => {
    if (!scrollContainer) return;
    const request = shouldRequestOlderPage({
      status: statusRef.current,
      scrollTop: scrollContainer.scrollTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight,
      userScrolledUp: userScrolledUpRef.current,
    });
    if (request) loadOlder();
  }, [loadOlder, scrollContainer]);

  useEffect(() => () => stopCorrectionRef.current?.(), []);

  useEffect(() => {
    userScrolledUpRef.current = false;
    anchorRef.current = null;
    stopCorrectionRef.current?.();
    if (!scrollContainer || !threadId) return;
    let lastScrollTop = scrollContainer.scrollTop;
    const onScroll = () => {
      if (scrollContainer.scrollTop < lastScrollTop) userScrolledUpRef.current = true;
      lastScrollTop = scrollContainer.scrollTop;
      evaluate();
    };
    scrollContainer.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", onScroll);
  }, [evaluate, scrollContainer, threadId]);

  useLayoutEffect(() => {
    const pending = anchorRef.current;
    if (!pending || !scrollContainer) return;
    const index =
      pending.anchor.rowId === null
        ? rowIds.length
        : rowIds.findIndex((id) => id === pending.anchor.rowId);
    if (index > pending.anchor.rowIndex) {
      scrollContainer.scrollTop = resolveAnchoredScrollTop(
        pending.anchor,
        readRowExtentsRef.current(),
        scrollContainer.scrollHeight,
      );
      anchorRef.current = null;
      stopCorrectionRef.current?.();
      stopCorrectionRef.current =
        pending.anchor.rowId !== null && pending.domOffset !== null
          ? correctAnchorDrift(scrollContainer, pending.anchor.rowId, pending.domOffset)
          : null;
      return;
    }
    if (status === "error" || status === "unavailable") {
      anchorRef.current = null;
    } else if (status !== "loading") {
      const now = performance.now();
      if (pending.settledAt === null) pending.settledAt = now;
      else if (now - pending.settledAt > ANCHOR_SETTLE_MS) anchorRef.current = null;
    }
  }, [rowIds, scrollContainer, status]);

  // A landed page in a timeline that is still too short to scroll continues filling it.
  useEffect(() => {
    if (status === "idle") evaluate();
  }, [evaluate, status, rowIds]);

  return { status, retry: loadOlder };
}
