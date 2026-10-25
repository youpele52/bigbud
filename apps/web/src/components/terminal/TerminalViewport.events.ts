import { type TerminalDropPathMode, type TerminalEvent } from "@bigbud/contracts";
import { type Terminal } from "@xterm/xterm";

import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { selectPendingTerminalEventEntries } from "./ThreadTerminalDrawer.logic";
import type { TerminalViewportIntake } from "./TerminalViewport.intake";

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
  readonly replaySnapshot: TerminalViewportIntake["replay"];
  readonly isDisposed: () => boolean;
  readonly clearSelectionAction: () => void;
  readonly handleSessionExited: () => void;
}) {
  let lifecycleGeneration = 0;
  return (event: TerminalEvent) => {
    const activeTerminal = input.terminalRef.current;
    if (!activeTerminal) {
      return;
    }

    if (event.type === "activity" || event.type === "agentIdentity") {
      return;
    }

    if (event.type === "output") {
      // Server output carries flow-control credit, released once xterm parses it.
      input.writeBatcher.write(activeTerminal, event.data, event.data.length);
      input.clearSelectionAction();
      return;
    }

    if (event.type === "started" || event.type === "restarted") {
      lifecycleGeneration++;
      input.hasHandledExitRef.current = false;
      input.dropPathModeRef.current = event.snapshot.dropPathMode;
      input.clearSelectionAction();
      input.replaySnapshot(event.snapshot);
      return;
    }

    if (event.type === "cleared") {
      input.clearSelectionAction();
      input.writeBatcher.barrier(() => activeTerminal.clear());
      input.writeBatcher.write(activeTerminal, "\u001bc");
      return;
    }

    if (event.type === "error") {
      input.writeBatcher.write(activeTerminal, `\r\n[terminal] ${event.message}\r\n`);
      return;
    }

    const details = [
      typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
      typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join(", ");
    input.writeBatcher.write(
      activeTerminal,
      `\r\n[terminal] ${details.length > 0 ? `Process exited (${details})` : "Process exited"}\r\n`,
    );
    if (input.hasHandledExitRef.current) {
      return;
    }
    input.hasHandledExitRef.current = true;
    const exitGeneration = lifecycleGeneration;
    input.writeBatcher.barrier(() => {
      if (
        input.isDisposed() ||
        input.terminalRef.current !== activeTerminal ||
        exitGeneration !== lifecycleGeneration ||
        !input.hasHandledExitRef.current
      ) {
        return;
      }
      input.handleSessionExited();
    });
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
