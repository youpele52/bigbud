import { useCallback } from "react";

import { useTerminalStateStore } from "~/stores/terminal/terminal.store";

import {
  resolveEffectiveTerminalLayoutMode,
  resolveTerminalLayoutVisibility,
  type TerminalLayoutMode,
} from "./terminalLayout.logic";

interface UseTerminalLayoutInput {
  readonly activeThreadId: string;
  readonly terminalOpen: boolean;
  readonly setTerminalOpen: (open: boolean) => void;
  readonly toggleTerminalVisibility: () => void;
}

export function useTerminalLayout(input: UseTerminalLayoutInput) {
  const { activeThreadId, setTerminalOpen, terminalOpen, toggleTerminalVisibility } = input;
  const selection = useTerminalStateStore(
    (state) => state.terminalLayoutByThreadId[activeThreadId],
  );
  const setLayout = useTerminalStateStore((state) => state.setTerminalLayout);
  const mode = resolveEffectiveTerminalLayoutMode({
    terminalOpen,
    selection,
  });

  const resetToSplit = useCallback(() => {
    setLayout(activeThreadId, "split");
  }, [activeThreadId, setLayout]);

  const openTerminal = useCallback(() => {
    resetToSplit();
    if (!terminalOpen) {
      setTerminalOpen(true);
    }
  }, [resetToSplit, setTerminalOpen, terminalOpen]);

  const toggleTerminal = useCallback(() => {
    resetToSplit();
    toggleTerminalVisibility();
  }, [resetToSplit, toggleTerminalVisibility]);

  const selectLayout = useCallback(
    (nextMode: TerminalLayoutMode) => {
      setLayout(activeThreadId, nextMode);
      // Chat-only is presentation-only: keep the mounted session and its output alive.
      if (nextMode !== "chat-only" && !terminalOpen) {
        setTerminalOpen(true);
      }
    },
    [activeThreadId, setLayout, setTerminalOpen, terminalOpen],
  );
  const toggleExpanded = useCallback(() => {
    selectLayout(mode === "terminal-only" ? "split" : "terminal-only");
  }, [mode, selectLayout]);

  return {
    mode,
    // Keep the existing close animation/unmount path; only the menu reports chat-only while closed.
    ...resolveTerminalLayoutVisibility(terminalOpen ? mode : "split"),
    selectLayout,
    toggleExpanded,
    openTerminal,
    toggleTerminal,
  };
}
