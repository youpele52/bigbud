import { type ThreadId } from "@bigbud/contracts";
import { create } from "zustand";

export type SideChatPresentation = "creating" | "open" | "minimized";

export interface SideChatClosingEntry {
  readonly deletionRequested: boolean;
  readonly startedAt: string;
}

interface SideChatState {
  closedThreadId: ThreadId | null;
  /**
   * Sidecars whose Close is still waiting for server deletion. They are hidden
   * immediately so the visible slot is free to open a fresh Sidecar.
   */
  closingThreads: Readonly<Record<ThreadId, SideChatClosingEntry>>;
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

function withoutClosing(
  closingThreads: SideChatState["closingThreads"],
  threadId: ThreadId,
): SideChatState["closingThreads"] {
  const { [threadId]: _removed, ...rest } = closingThreads;
  return rest;
}

export function isSideChatClosing(
  state: Pick<SideChatState, "closingThreads">,
  threadId: ThreadId,
): boolean {
  return threadId in state.closingThreads;
}

export const useSideChatStore = create<SideChatState>((set) => ({
  closedThreadId: null,
  closingThreads: {},
  presentation: "open",
  threadId: null,
  beginClose: (threadId, startedAt) =>
    set((state) =>
      isSideChatClosing(state, threadId)
        ? state
        : {
            closingThreads: {
              ...state.closingThreads,
              [threadId]: { deletionRequested: false, startedAt },
            },
            ...(state.threadId === threadId ? { presentation: "open", threadId: null } : {}),
          },
    ),
  beginCreate: (threadId) =>
    set({
      closedThreadId: null,
      presentation: "creating",
      threadId,
    }),
  clearMissing: (threadId) =>
    set((state) =>
      state.threadId === threadId
        ? { closedThreadId: null, presentation: "open", threadId: null }
        : state,
    ),
  completeClose: (threadId) =>
    set((state) => ({
      closedThreadId: threadId,
      closingThreads: withoutClosing(state.closingThreads, threadId),
      ...(state.threadId === threadId ? { presentation: "open", threadId: null } : {}),
    })),
  completeCreate: (threadId) =>
    set((state) =>
      state.threadId === threadId && state.presentation === "creating"
        ? { presentation: "open" }
        : state,
    ),
  failClose: (threadId) =>
    set((state) => {
      if (!isSideChatClosing(state, threadId)) {
        return state;
      }
      const closingThreads = withoutClosing(state.closingThreads, threadId);
      // Bring the surviving Sidecar back only when no newer Sidecar took the slot.
      return state.threadId === null
        ? { closedThreadId: null, closingThreads, presentation: "open", threadId }
        : { closingThreads };
    }),
  failCreate: (threadId) =>
    set((state) =>
      state.threadId === threadId && state.presentation === "creating"
        ? { closedThreadId: null, presentation: "open", threadId: null }
        : state,
    ),
  markDeletionRequested: (threadId) =>
    set((state) => {
      const entry = state.closingThreads[threadId];
      return entry && !entry.deletionRequested
        ? {
            closingThreads: {
              ...state.closingThreads,
              [threadId]: { ...entry, deletionRequested: true },
            },
          }
        : state;
    }),
  minimize: () => set((state) => (state.threadId ? { presentation: "minimized" } : state)),
  restore: () => set((state) => (state.threadId ? { presentation: "open" } : state)),
  show: (threadId) =>
    set((state) =>
      isSideChatClosing(state, threadId) ||
      (state.threadId === threadId &&
        state.presentation === "open" &&
        state.closedThreadId === null)
        ? state
        : { closedThreadId: null, presentation: "open", threadId },
    ),
}));
