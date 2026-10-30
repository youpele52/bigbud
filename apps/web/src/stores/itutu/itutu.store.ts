import type { ThreadSummaryCursor } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { create } from "zustand";

import {
  persistItutuState,
  readPersistedItutuState,
  type SidebarArrangement,
} from "./itutu.store.persistence";

export type { SidebarArrangement } from "./itutu.store.persistence";

/** Paging of one Ìtútù state. Group membership itself is derived from known thread summaries. */
export interface ItutuStatePage {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly nextCursor: ThreadSummaryCursor | null;
  /** Bumped when a live move lands in this state, so an open view reloads its first page. */
  readonly staleVersion: number;
}

const IDLE_PAGE: ItutuStatePage = { status: "idle", nextCursor: null, staleVersion: 0 };

interface ItutuStore {
  readonly arrangement: SidebarArrangement;
  readonly collapsedStates: readonly ThreadOrganizationState[];
  readonly pages: Readonly<Record<ThreadOrganizationState, ItutuStatePage>>;
  setArrangement: (arrangement: SidebarArrangement) => void;
  setStateCollapsed: (state: ThreadOrganizationState, collapsed: boolean) => void;
  setPage: (state: ThreadOrganizationState, page: Partial<ItutuStatePage>) => void;
  markStale: (state: ThreadOrganizationState) => void;
}

const persisted = readPersistedItutuState();

export const useItutuStore = create<ItutuStore>((set, get) => {
  const persist = () => {
    const { arrangement, collapsedStates } = get();
    persistItutuState({ arrangement, collapsedStates });
  };
  return {
    arrangement: persisted.arrangement,
    collapsedStates: persisted.collapsedStates,
    pages: { present: IDLE_PAGE, "needs-you": IDLE_PAGE, later: IDLE_PAGE, done: IDLE_PAGE },
    setArrangement: (arrangement) => {
      set({ arrangement });
      persist();
    },
    setStateCollapsed: (state, collapsed) => {
      const current = get().collapsedStates;
      if (current.includes(state) === collapsed) return;
      set({
        collapsedStates: collapsed
          ? [...current, state]
          : current.filter((entry) => entry !== state),
      });
      persist();
    },
    setPage: (state, page) =>
      set((current) => ({
        pages: { ...current.pages, [state]: { ...current.pages[state], ...page } },
      })),
    markStale: (state) =>
      set((current) => ({
        pages: {
          ...current.pages,
          [state]: { ...current.pages[state], staleVersion: current.pages[state].staleVersion + 1 },
        },
      })),
  };
});
