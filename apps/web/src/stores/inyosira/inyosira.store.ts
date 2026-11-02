import type { ThreadSummaryCursor } from "@bigbud/contracts/orchestration/orchestration.catalog.ts";
import type { ThreadOrganizationState } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { create } from "zustand";

import {
  persistInyosiraState,
  readPersistedInyosiraState,
  type SidebarArrangement,
} from "./inyosira.store.persistence";

export type { SidebarArrangement } from "./inyosira.store.persistence";

/** Paging of one Inyosira state. Group membership itself is derived from known thread summaries. */
export interface InyosiraStatePage {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly nextCursor: ThreadSummaryCursor | null;
  /** Bumped when a live move lands in this state, so an open view reloads its first page. */
  readonly staleVersion: number;
}

const IDLE_PAGE: InyosiraStatePage = { status: "idle", nextCursor: null, staleVersion: 0 };

interface InyosiraStore {
  readonly arrangement: SidebarArrangement;
  readonly collapsedStates: readonly ThreadOrganizationState[];
  readonly pages: Readonly<Record<ThreadOrganizationState, InyosiraStatePage>>;
  setArrangement: (arrangement: SidebarArrangement) => void;
  setStateCollapsed: (state: ThreadOrganizationState, collapsed: boolean) => void;
  setPage: (state: ThreadOrganizationState, page: Partial<InyosiraStatePage>) => void;
  markStale: (state: ThreadOrganizationState) => void;
}

const persisted = readPersistedInyosiraState();

export const useInyosiraStore = create<InyosiraStore>((set, get) => {
  const persist = () => {
    const { arrangement, collapsedStates } = get();
    persistInyosiraState({ arrangement, collapsedStates });
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
