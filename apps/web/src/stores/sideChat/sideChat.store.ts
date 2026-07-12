import { type ThreadId } from "@bigbud/contracts";
import { create } from "zustand";

export type SideChatPresentation = "creating" | "open" | "minimized" | "closing";

interface SideChatState {
  closedThreadId: ThreadId | null;
  closeStartedAt: string | null;
  deletionRequested: boolean;
  presentation: SideChatPresentation;
  threadId: ThreadId | null;
  beginClose: (threadId: ThreadId, startedAt: string) => void;
  beginCreate: (threadId: ThreadId) => void;
  clearMissing: (threadId: ThreadId) => void;
  completeClose: (threadId: ThreadId) => void;
  completeCreate: (threadId: ThreadId) => void;
  failClose: (threadId: ThreadId) => void;
  failCreate: (threadId: ThreadId) => void;
  markDeletionRequested: (threadId: ThreadId) => void;
  minimize: () => void;
  restore: () => void;
  show: (threadId: ThreadId) => void;
}

export const useSideChatStore = create<SideChatState>((set) => ({
  closedThreadId: null,
  closeStartedAt: null,
  deletionRequested: false,
  presentation: "open",
  threadId: null,
  beginClose: (threadId, startedAt) =>
    set((state) =>
      state.threadId === threadId
        ? {
            ...state,
            closeStartedAt: startedAt,
            deletionRequested: false,
            presentation: "closing",
          }
        : state,
    ),
  beginCreate: (threadId) =>
    set({
      closedThreadId: null,
      closeStartedAt: null,
      deletionRequested: false,
      presentation: "creating",
      threadId,
    }),
  clearMissing: (threadId) =>
    set((state) =>
      state.threadId === threadId
        ? {
            closedThreadId: null,
            closeStartedAt: null,
            deletionRequested: false,
            presentation: "open",
            threadId: null,
          }
        : state,
    ),
  completeClose: (threadId) =>
    set((state) =>
      state.threadId === threadId
        ? {
            closedThreadId: threadId,
            closeStartedAt: null,
            deletionRequested: false,
            presentation: "open",
            threadId: null,
          }
        : state,
    ),
  completeCreate: (threadId) =>
    set((state) =>
      state.threadId === threadId && state.presentation === "creating"
        ? { ...state, presentation: "open" }
        : state,
    ),
  failClose: (threadId) =>
    set((state) =>
      state.threadId === threadId
        ? {
            ...state,
            closeStartedAt: null,
            deletionRequested: false,
            presentation: "open",
          }
        : state,
    ),
  failCreate: (threadId) =>
    set((state) =>
      state.threadId === threadId && state.presentation === "creating"
        ? {
            closedThreadId: null,
            closeStartedAt: null,
            deletionRequested: false,
            presentation: "open",
            threadId: null,
          }
        : state,
    ),
  markDeletionRequested: (threadId) =>
    set((state) =>
      state.threadId === threadId && state.presentation === "closing" && !state.deletionRequested
        ? { ...state, deletionRequested: true }
        : state,
    ),
  minimize: () =>
    set((state) => (state.threadId ? { ...state, presentation: "minimized" } : state)),
  restore: () => set((state) => (state.threadId ? { ...state, presentation: "open" } : state)),
  show: (threadId) =>
    set((state) =>
      state.threadId === threadId && state.presentation === "open" && state.closedThreadId === null
        ? state
        : {
            closedThreadId: null,
            closeStartedAt: null,
            deletionRequested: false,
            presentation: "open",
            threadId,
          },
    ),
}));
