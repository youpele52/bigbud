import { create } from "zustand";

import { fnv1a32 } from "../../lib/diffRendering";

interface ThreadNoticeDismissalState {
  readonly dismissed: ReadonlySet<string>;
  dismiss: (key: string) => void;
}

/** Renderer-session UI state only: never persisted or applied to thread/provider state. */
export const useThreadNoticeDismissalStore = create<ThreadNoticeDismissalState>((set) => ({
  dismissed: new Set(),
  dismiss: (key) => set((state) => ({ dismissed: new Set([...state.dismissed, key]) })),
}));

/** Compact condition identities avoid retaining full provider error messages in store keys. */
export function useThreadNoticeDismissal(threadId: string, kind: string, condition: unknown) {
  const serialized = JSON.stringify(condition) ?? "";
  const fingerprint = `${serialized.length}:${fnv1a32(serialized).toString(36)}:${fnv1a32(serialized, 0x9e3779b9).toString(36)}`;
  const key = JSON.stringify([threadId, kind, fingerprint]);
  const dismissed = useThreadNoticeDismissalStore((state) => state.dismissed.has(key));
  const dismiss = useThreadNoticeDismissalStore((state) => state.dismiss);
  return { dismissed, dismiss: () => dismiss(key) };
}
