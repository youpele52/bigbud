import { create } from "zustand";
import { pruneNoticeDismissals } from "./noticeDismissal.retention";

interface ContextWindowDismissalState {
  readonly rearmTokensByThread: ReadonlyMap<string, number>;
  setRearmTokens: (threadId: string, tokens: number | undefined) => void;
}

/** Keep token-based rearming across navigation, without persisting it across renderer reloads. */
export const useContextWindowDismissalStore = create<ContextWindowDismissalState>((set) => ({
  rearmTokensByThread: new Map(),
  setRearmTokens: (threadId, tokens) =>
    set((state) => {
      const rearmTokensByThread = new Map(state.rearmTokensByThread);
      rearmTokensByThread.delete(threadId);
      if (tokens !== undefined) rearmTokensByThread.set(threadId, tokens);
      pruneNoticeDismissals(rearmTokensByThread);
      return { rearmTokensByThread };
    }),
}));
