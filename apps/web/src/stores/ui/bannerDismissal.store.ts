import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { createSessionNoticeStorage } from "../../lib/sessionNoticeStorage";

interface BannerDismissalState {
  readonly serverRunId: string | null;
  readonly dismissed: ReadonlySet<string>;
  observeRun: (serverRunId: string | null | undefined) => void;
  dismiss: (key: string, serverRunId?: string | null) => void;
}
interface PersistedDismissals {
  serverRunId: string | null;
  dismissed: string[];
}

/** App-run UI state. No eviction: a dismissed banner stays closed for the entire run. */
export function createBannerDismissalStore(storage: StateStorage) {
  return create<BannerDismissalState>()(
    persist<BannerDismissalState, [], [], PersistedDismissals>(
      (set, get) => ({
        serverRunId: null,
        dismissed: new Set(),
        observeRun: (serverRunId) => {
          const state = get();
          if (!serverRunId || state.serverRunId === serverRunId) return;
          set({ serverRunId, dismissed: state.serverRunId ? new Set() : state.dismissed });
        },
        dismiss: (key, serverRunId) =>
          set((state) => ({
            serverRunId: serverRunId ?? state.serverRunId,
            dismissed: new Set([
              ...(serverRunId && state.serverRunId && serverRunId !== state.serverRunId
                ? []
                : state.dismissed),
              key,
            ]),
          })),
      }),
      {
        name: "bigbud:session-banner-dismissals",
        storage: createJSONStorage(() => storage),
        partialize: ({ serverRunId, dismissed }) => ({ serverRunId, dismissed: [...dismissed] }),
        merge: (persisted, current) => {
          const saved = persisted as Partial<PersistedDismissals> | undefined;
          if (
            typeof saved?.serverRunId !== "string" ||
            !Array.isArray(saved.dismissed) ||
            !saved.dismissed.every((key) => typeof key === "string")
          )
            return current;
          return {
            ...current,
            serverRunId: saved.serverRunId,
            dismissed: new Set(saved.dismissed),
          };
        },
      },
    ),
  );
}

export const useBannerDismissalStore = createBannerDismissalStore(createSessionNoticeStorage());
