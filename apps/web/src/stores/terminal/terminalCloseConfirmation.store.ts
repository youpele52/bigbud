import { create } from "zustand";

/** A close of a busy terminal waiting for the user's answer. */
export interface PendingTerminalClose {
  readonly threadId: string;
  readonly terminalId: string;
  /** The terminal's tab label, shown in the dialog. */
  readonly label: string;
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
