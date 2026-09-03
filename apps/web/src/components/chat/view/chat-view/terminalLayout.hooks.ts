import { useCallback, useRef, useState } from "react";

import {
  cycleTerminalLayoutMode,
  resolveEffectiveTerminalLayoutMode,
  resolveTerminalLayoutVisibility,
  terminalLayoutNextActionLabel,
  type TerminalLayoutSelection,
} from "./terminalLayout.logic";

interface UseTerminalLayoutInput {
  readonly activeThreadId: string;
  readonly terminalOpen: boolean;
  readonly setTerminalOpen: (open: boolean) => void;
  readonly toggleTerminalVisibility: () => void;
}

export function useTerminalLayout(input: UseTerminalLayoutInput) {
  const { activeThreadId, setTerminalOpen, terminalOpen, toggleTerminalVisibility } = input;
  const identityRef = useRef({
    threadId: activeThreadId,
    terminalOpen,
    epoch: 0,
  });
  const identity = identityRef.current;
  if (identity.threadId !== activeThreadId) {
    identity.threadId = activeThreadId;
    identity.epoch += 1;
  } else if (identity.terminalOpen && !terminalOpen) {
    identity.epoch += 1;
  }
  identity.terminalOpen = terminalOpen;

  const [selection, setSelection] = useState<TerminalLayoutSelection>(() => ({
    threadId: activeThreadId,
    epoch: identity.epoch,
    mode: "split",
  }));
  const mode = resolveEffectiveTerminalLayoutMode({
    terminalOpen,
    activeThreadId,
    activeEpoch: identity.epoch,
    selection,
  });

  const resetToSplit = useCallback(() => {
    setSelection({
      threadId: identityRef.current.threadId,
      epoch: identityRef.current.epoch,
      mode: "split",
    });
  }, []);

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

  const cycleLayout = useCallback(() => {
    setSelection({
      threadId: identityRef.current.threadId,
      epoch: identityRef.current.epoch,
      mode: cycleTerminalLayoutMode(mode),
    });
  }, [mode]);

  return {
    mode,
    ...resolveTerminalLayoutVisibility(mode),
    nextActionLabel: terminalLayoutNextActionLabel(mode),
    cycleLayout,
    openTerminal,
    toggleTerminal,
  };
}
