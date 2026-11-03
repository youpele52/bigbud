import {
  THREAD_ORGANIZATION_STATES,
  type ThreadOrganizationState,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { useCallback, useEffect } from "react";

import { readNativeApi } from "../../rpc/nativeApi";
import { useInyosiraStore } from "../../stores/inyosira/inyosira.store";
import { useStore } from "../../stores/main";

const inFlight = new Map<ThreadOrganizationState, Promise<void>>();

/**
 * Loads one state page into the known thread summaries. `reset` reloads the first page; otherwise
 * the next page after the stored cursor is loaded. One request per state runs at a time.
 */
async function loadInyosiraPage(state: ThreadOrganizationState, reset: boolean): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  const running = inFlight.get(state);
  if (running) return running;
  const store = useInyosiraStore.getState();
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
      const current = useInyosiraStore.getState().pages[state];
      // A first-page reload keeps the deeper cursor the user already reached.
      const nextCursor =
        reset && current.nextCursor !== null ? current.nextCursor : page.nextCursor;
      useInyosiraStore.getState().setPage(state, {
        status: "loaded",
        nextCursor: nextCursor ?? null,
      });
    } catch {
      useInyosiraStore.getState().setPage(state, { status: "error" });
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
 * While Inyosira is shown, loads the first page of every expanded state once, and reloads a state's
 * first page when a live move brings an unknown thread into it.
 */
export function useInyosiraCatalog(enabled: boolean) {
  const pages = useInyosiraStore((store) => store.pages);
  const collapsedStates = useInyosiraStore((store) => store.collapsedStates);
  const staleKey = THREAD_ORGANIZATION_STATES.map((state) => pages[state].staleVersion).join(":");

  useEffect(() => {
    if (!enabled) return;
    for (const state of THREAD_ORGANIZATION_STATES) {
      if (collapsedStates.includes(state)) continue;
      if (pages[state].status === "idle") void loadInyosiraPage(state, true);
    }
    // `pages` is read for the idle check only; status changes must not trigger reloads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, collapsedStates]);

  useEffect(() => {
    if (!enabled) return;
    for (const state of THREAD_ORGANIZATION_STATES) {
      if (pages[state].staleVersion > 0 && !collapsedStates.includes(state)) {
        void loadInyosiraPage(state, true);
      }
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, staleKey]);

  const loadMore = useCallback((state: ThreadOrganizationState) => {
    const page = useInyosiraStore.getState().pages[state];
    // A failed first page has no cursor yet; retry it rather than silently doing nothing.
    void loadInyosiraPage(state, page.status === "error" && page.nextCursor === null);
  }, []);

  return { pages, loadMore };
}
