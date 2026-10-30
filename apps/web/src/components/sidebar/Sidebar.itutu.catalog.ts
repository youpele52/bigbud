import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { useCallback, useEffect } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { useItutuStore } from "../../stores/itutu/itutu.store";
import { useStore } from "../../stores/main";

const inFlight = new Map<ThreadOrganizationState, Promise<void>>();

/**
 * Loads one state page into the known thread summaries. `reset` reloads the first page; otherwise
 * the next page after the stored cursor is loaded. One request per state runs at a time.
 */
async function loadItutuPage(state: ThreadOrganizationState, reset: boolean): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const running = inFlight.get(state);
  if (running) return running;
  const store = useItutuStore.getState();
  const cursor = reset ? null : store.pages[state].nextCursor;
  if (!reset && cursor === null) return;
  store.setPage(state, { status: "loading" });
  const operation = (async () => {
    try {
      const page = await api.orchestration.getOrganizationThreadSummaries({
        state,
        ...(cursor ? { cursor } : {}),
      });
      useStore.getState().appendOrganizationPage(page);
      const current = useItutuStore.getState().pages[state];
      // A first-page reload keeps the deeper cursor the user already reached.
      const nextCursor =
        reset && current.nextCursor !== null ? current.nextCursor : page.nextCursor;
      useItutuStore.getState().setPage(state, {
        status: "loaded",
        nextCursor: nextCursor ?? null,
      });
    } catch {
      useItutuStore.getState().setPage(state, { status: "error" });
    }
  })();
  inFlight.set(state, operation);
  try {
    await operation;
  } finally {
    inFlight.delete(state);
  }
}

/**
 * While Ìtútù is shown, loads the first page of every expanded state once, and reloads a state's
 * first page when a live move brings an unknown thread into it.
 */
export function useItutuCatalog(enabled: boolean) {
  const pages = useItutuStore((store) => store.pages);
  const collapsedStates = useItutuStore((store) => store.collapsedStates);
  const staleKey = THREAD_ORGANIZATION_STATES.map((state) => pages[state].staleVersion).join(":");

  useEffect(() => {
    if (!enabled) return;
    for (const state of THREAD_ORGANIZATION_STATES) {
      if (collapsedStates.includes(state)) continue;
      if (pages[state].status === "idle") void loadItutuPage(state, true);
    }
    // `pages` is read for the idle check only; status changes must not trigger reloads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, collapsedStates]);

  useEffect(() => {
    if (!enabled) return;
    for (const state of THREAD_ORGANIZATION_STATES) {
      if (pages[state].staleVersion > 0 && !collapsedStates.includes(state)) {
        void loadItutuPage(state, true);
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, staleKey]);

  const loadMore = useCallback((state: ThreadOrganizationState) => {
    void loadItutuPage(state, false);
  }, []);

  return { pages, loadMore };
}
