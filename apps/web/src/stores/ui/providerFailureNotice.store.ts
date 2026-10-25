import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { createSessionNoticeStorage } from "../../lib/sessionNoticeStorage";

interface FailureNotice {
  readonly message: string;
  readonly dismissed: boolean;
}

interface ProviderFailureNoticeState {
  readonly serverRunId: string | null;
  readonly notices: Record<string, FailureNotice>;
  observe: (serverRunId: string, threadId: string, message: string | null) => void;
  dismiss: (serverRunId: string, threadId: string) => void;
}

/** Persist across renderer reloads; only a new backend process resets suppression. */
export function createProviderFailureNoticeStore(storage: StateStorage) {
  return create<ProviderFailureNoticeState>()(
    persist(
      (set) => ({
        serverRunId: null,
        notices: {},
        observe: (serverRunId, threadId, message) =>
          set((state) => {
            const notices = state.serverRunId === serverRunId ? state.notices : {};
            if (!message || notices[threadId]) {
              return state.serverRunId === serverRunId ? state : { serverRunId, notices };
            }
            return {
              serverRunId,
              notices: { ...notices, [threadId]: { message, dismissed: false } },
            };
          }),
        dismiss: (serverRunId, threadId) =>
          set((state) => {
            const notice = state.notices[threadId];
            if (state.serverRunId !== serverRunId || !notice || notice.dismissed) return state;
            return { notices: { ...state.notices, [threadId]: { ...notice, dismissed: true } } };
          }),
      }),
      {
        name: "bigbud:provider-failure-notices",
        storage: createJSONStorage(() => storage),
        partialize: ({ serverRunId, notices }) => ({ serverRunId, notices }),
      },
    ),
  );
}

export const useProviderFailureNoticeStore = createProviderFailureNoticeStore(
  createSessionNoticeStorage(),
);
