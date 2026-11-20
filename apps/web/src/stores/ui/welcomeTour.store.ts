import { type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { create } from "zustand";

/** `tour` walks through every step; `file-access` re-asks only File Access after a reset. */
export type WelcomeTourMode = "tour" | "file-access";

interface WelcomeTourState {
  open: boolean;
  /** Kept while closing so the exit animation still renders the same steps. */
  mode: WelcomeTourMode;
  /** A finished tour asks the next eligible empty chat to show the welcome greeting. */
  welcomeGreetingPending: boolean;
  welcomeGreetingThreadId: ThreadId | null;
  openTour: (mode: WelcomeTourMode) => void;
  closeTour: () => void;
  requestWelcomeGreeting: () => void;
  claimWelcomeGreeting: (threadId: ThreadId) => void;
}

export const useWelcomeTourStore = create<WelcomeTourState>((set) => ({
  open: false,
  mode: "tour",
  welcomeGreetingPending: false,
  welcomeGreetingThreadId: null,
  openTour: (mode) =>
    set((state) => (state.open && state.mode === mode ? state : { open: true, mode })),
  closeTour: () => set((state) => (state.open ? { open: false } : state)),
  requestWelcomeGreeting: () =>
    set({ welcomeGreetingPending: true, welcomeGreetingThreadId: null }),
  claimWelcomeGreeting: (threadId) =>
    set((state) =>
      state.welcomeGreetingPending
        ? { welcomeGreetingPending: false, welcomeGreetingThreadId: threadId }
        : state,
    ),
}));

/** True when `threadId` shows the welcome greeting, or may claim the pending one. */
export function selectShowsWelcomeGreeting(threadId: ThreadId) {
  return (state: WelcomeTourState) =>
    state.welcomeGreetingPending || state.welcomeGreetingThreadId === threadId;
}
