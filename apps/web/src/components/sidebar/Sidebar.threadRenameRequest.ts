import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { create } from "zustand";

/** Like terminal-find requests, navigation/remount may fulfill this briefly, never indefinitely. */
export const THREAD_RENAME_REQUEST_TTL_MS = 15_000;

/** A transient UI request, never a metadata-generation retry or a rename command. */
export const useThreadRenameRequest = create<{
  threadId: ThreadId | null;
  requestId: number;
  expiresAt: number;
  request: (threadId: ThreadId) => void;
  consume: (requestId: number) => void;
}>((set, get) => ({
  threadId: null,
  requestId: 0,
  expiresAt: 0,
  request: (threadId) => {
    const requestId = get().requestId + 1;
    set({ threadId, requestId, expiresAt: Date.now() + THREAD_RENAME_REQUEST_TTL_MS });
    // Store-owned expiry survives sidebar unmounts and cannot erase a newer request.
    setTimeout(() => get().consume(requestId), THREAD_RENAME_REQUEST_TTL_MS);
  },
  consume: (requestId) =>
    set((state) => (state.requestId === requestId ? { threadId: null } : state)),
}));
