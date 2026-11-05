import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { getMessagesTimelineRowMeasurementKey } from "./MessagesTimeline.virtualization";

const MAX_TAIL_MEASUREMENTS = 128;

function openIds(state: Readonly<Record<string, boolean>>): string[] {
  return Object.keys(state)
    .filter((id) => state[id])
    .toSorted();
}

/** Keep tail measurements across virtualization transitions without reobserving streaming rows. */
export function useTailRowMeasurements(input: {
  timelineRootRef: RefObject<HTMLDivElement | null>;
  timelineWidthPx: number | null;
  rows: ReadonlyArray<MessagesTimelineRow>;
  virtualizedRowCount: number;
  expandedWorkGroups: Readonly<Record<string, boolean>>;
  activityAccordionOpenById: Readonly<Record<string, boolean>>;
  changedFilesExpandedByTurnId: Readonly<Record<string, boolean>>;
}) {
  const {
    timelineRootRef,
    timelineWidthPx,
    rows,
    virtualizedRowCount,
    expandedWorkGroups,
    activityAccordionOpenById,
    changedFilesExpandedByTurnId,
  } = input;
  const measurementsRef = useRef(new Map<string, number>());
  const scopeRef = useRef({ signature: "", generation: 0 });
  const signature = JSON.stringify([
    timelineWidthPx === null ? null : Math.round(timelineWidthPx),
    openIds(expandedWorkGroups),
    openIds(activityAccordionOpenById),
    openIds(changedFilesExpandedByTurnId),
  ]);
  if (scopeRef.current.signature !== signature) {
    scopeRef.current = { signature, generation: scopeRef.current.generation + 1 };
    measurementsRef.current.clear();
  }
  const measurementScopeKey = `scope:${scopeRef.current.generation}`;
  const tailKeys = useMemo(
    () => JSON.stringify(rows.slice(virtualizedRowCount).map(getMessagesTimelineRowMeasurementKey)),
    [rows, virtualizedRowCount],
  );

  const recordHeight = useCallback((element: HTMLElement) => {
    const key = element.dataset.tailMeasurementKey;
    if (!key || element.getClientRects().length === 0) return;
    const measurements = measurementsRef.current;
    measurements.set(key, element.getBoundingClientRect().height);
    if (measurements.size > MAX_TAIL_MEASUREMENTS) {
      const oldest = measurements.keys().next().value;
      if (oldest) measurements.delete(oldest);
    }
  }, []);
  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new Set<HTMLElement>());
  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) recordHeight(entry.target as HTMLElement);
    });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
      observedRef.current.clear();
    };
  }, [recordHeight]);

  const previousScopeRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const observer = observerRef.current;
    if (!observer) return;
    const nextRows = new Set(
      timelineRootRef.current?.querySelectorAll<HTMLElement>("[data-tail-measurement-key]"),
    );
    for (const row of observedRef.current) {
      if (!nextRows.has(row)) observer.unobserve(row);
    }
    for (const row of nextRows) {
      if (!observedRef.current.has(row)) observer.observe(row);
      if (!observedRef.current.has(row) || previousScopeRef.current !== measurementScopeKey) {
        recordHeight(row);
      }
    }
    observedRef.current = nextRows;
    previousScopeRef.current = measurementScopeKey;
  }, [measurementScopeKey, recordHeight, tailKeys, timelineRootRef]);

  return { measurementsRef, measurementScopeKey };
}
