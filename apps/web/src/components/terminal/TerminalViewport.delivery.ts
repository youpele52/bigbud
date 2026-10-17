import type { Terminal } from "@xterm/xterm";
import type { TerminalDropPathMode } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { makeApplyTerminalEvent } from "./TerminalViewport.events";

/** Replace only a failed view's delivery lane; emulator and PTY ownership stay unchanged. */
export function createTerminalViewportDelivery(input: {
  terminalRef: { current: Terminal | null };
  hasHandledExitRef: { current: boolean };
  dropPathModeRef: { current: TerminalDropPathMode };
  clearSelectionAction: () => void;
  handleSessionExited: () => void;
  onInputState: (enabled: boolean) => void;
  onFailure: (error: Error) => void;
}) {
  let disposed = false;
  const terminal = input.terminalRef.current!;
  const writeBatcher = new TerminalWriteBatcher((error) => {
    if (disposed) return;
    terminal.options.disableStdin = true;
    input.onInputState(false);
    input.onFailure(error);
  });
  const apply = makeApplyTerminalEvent({
    ...input,
    writeBatcher,
    replaySnapshot: (snapshot) => intake.replay(snapshot),
    isDisposed: () => disposed,
  });
  const intake = new TerminalViewportIntake(terminal, writeBatcher, apply, (enabled) => {
    if (!disposed) input.onInputState(enabled);
  });
  return {
    intake,
    writeBatcher,
    dispose() {
      disposed = true;
      intake.dispose();
      writeBatcher.dispose();
    },
  };
}
