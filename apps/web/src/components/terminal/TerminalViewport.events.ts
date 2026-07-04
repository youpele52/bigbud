import { type TerminalDropPathMode, type TerminalEvent } from "@bigbud/contracts";
import { type Terminal } from "@xterm/xterm";

import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { selectPendingTerminalEventEntries } from "./ThreadTerminalDrawer.logic";
import { writeSystemMessage, writeTerminalSnapshot } from "./ThreadTerminalDrawer.logic";

interface TerminalRefLike {
  current: Terminal | null;
}

interface BooleanRefLike {
  current: boolean;
}

interface NumberRefLike {
  current: number;
}

interface DropPathModeRefLike {
  current: TerminalDropPathMode;
}

interface TerminalEventEntry {
  readonly id: number;
  readonly event: TerminalEvent;
}

export function makeApplyTerminalEvent(input: {
  readonly terminalRef: TerminalRefLike;
  readonly hasHandledExitRef: BooleanRefLike;
  readonly dropPathModeRef: DropPathModeRefLike;
  readonly writeBatcher: TerminalWriteBatcher;
  readonly clearSelectionAction: () => void;
  readonly handleSessionExited: () => void;
}) {
  return (event: TerminalEvent) => {
    const activeTerminal = input.terminalRef.current;
    if (!activeTerminal) {
      return;
    }

    if (event.type === "activity") {
      return;
    }

    if (event.type === "output") {
      input.writeBatcher.write(activeTerminal, event.data);
      input.clearSelectionAction();
      return;
    }

    if (event.type === "started" || event.type === "restarted") {
      input.hasHandledExitRef.current = false;
      input.dropPathModeRef.current = event.snapshot.dropPathMode;
      input.clearSelectionAction();
      input.writeBatcher.flush();
      writeTerminalSnapshot(activeTerminal, event.snapshot);
      return;
    }

    if (event.type === "cleared") {
      input.clearSelectionAction();
      input.writeBatcher.flush();
      activeTerminal.clear();
      activeTerminal.write("\u001bc");
      return;
    }

    if (event.type === "error") {
      input.writeBatcher.flush();
      writeSystemMessage(activeTerminal, event.message);
      return;
    }

    const details = [
      typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
      typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ");
    input.writeBatcher.flush();
    writeSystemMessage(
      activeTerminal,
      details.length > 0 ? `Process exited (${details})` : "Process exited",
    );
    if (input.hasHandledExitRef.current) {
      return;
    }
    input.hasHandledExitRef.current = true;
    window.setTimeout(() => {
      if (!input.hasHandledExitRef.current) {
        return;
      }
      input.handleSessionExited();
    }, 0);
  };
}

export function applyPendingTerminalEvents(input: {
  readonly terminalEventEntries: ReadonlyArray<TerminalEventEntry>;
  readonly lastAppliedTerminalEventIdRef: NumberRefLike;
  readonly applyTerminalEvent: (event: TerminalEvent) => void;
}) {
  const pendingEntries = selectPendingTerminalEventEntries(
    input.terminalEventEntries,
    input.lastAppliedTerminalEventIdRef.current,
  );
  if (pendingEntries.length === 0) {
    return;
  }
  for (const entry of pendingEntries) {
    input.applyTerminalEvent(entry.event);
  }
  input.lastAppliedTerminalEventIdRef.current =
    pendingEntries.at(-1)?.id ?? input.lastAppliedTerminalEventIdRef.current;
}
