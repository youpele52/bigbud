import { create } from "zustand";

/** A close waiting for the user's answer: one busy terminal, or a batch ("Close all"). */
export interface PendingTerminalClose {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  /** A single terminal whose exit makes the question moot; null for a batch. */
  readonly watch: { readonly threadId: string; readonly terminalId: string } | null;
  readonly close: () => void;
}

interface TerminalCloseConfirmationState {
  readonly pending: PendingTerminalClose | null;
  request: (pending: PendingTerminalClose) => void;
  dismiss: () => void;
}

/** One pending request at a time; a newer request replaces an unanswered one. */
export const useTerminalCloseConfirmationStore = create<TerminalCloseConfirmationState>((set) => ({
  pending: null,
  request: (pending) => set({ pending }),
  dismiss: () => set({ pending: null }),
}));
