import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

import { createMemoryStorage, resolveStorage } from "../../lib/storage";

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

function noticeStorage(): StateStorage {
  const fallback = createMemoryStorage();
  try {
    const storage = resolveStorage(typeof window !== "undefined" ? window.localStorage : null);
    return {
      getItem: (key) => {
        try {
          return storage.getItem(key);
        } catch {
          return fallback.getItem(key);
        }
      },
      setItem: (key, value) => {
        fallback.setItem(key, value);
        try {
          storage.setItem(key, value);
        } catch {
          console.warn(
            "[provider-failure-notice] Dismissal could not be saved across page reloads.",
          );
        }
      },
      removeItem: (key) => {
        fallback.removeItem(key);
        try {
          storage.removeItem(key);
        } catch {
          /* In-memory state remains available. */
        }
      },
    };
  } catch {
    return fallback;
  }
}

export const useProviderFailureNoticeStore = createProviderFailureNoticeStore(noticeStorage());
