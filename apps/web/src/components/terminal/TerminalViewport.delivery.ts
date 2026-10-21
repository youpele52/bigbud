import type { Terminal } from "@xterm/xterm";
import type { TerminalDropPathMode } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher, type TerminalWriteBatcherOptions } from "./TerminalWriteBatcher";
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
  /** Sees every output chunk the view receives (frame metrics); must not retain the text. */
  observeOutput?: (data: string) => void;
  batcherOptions?: TerminalWriteBatcherOptions;
}) {
  let disposed = false;
  const terminal = input.terminalRef.current!;
  const writeBatcher = new TerminalWriteBatcher((error) => {
    if (disposed) return;
    terminal.options.disableStdin = true;
    input.onInputState(false);
    input.onFailure(error);
  }, input.batcherOptions);
  const applyEvent = makeApplyTerminalEvent({
    ...input,
    writeBatcher,
    replaySnapshot: (snapshot) => intake.replay(snapshot),
    isDisposed: () => disposed,
  });
  const observeOutput = input.observeOutput;
  const apply: typeof applyEvent = observeOutput
    ? (event) => {
        if (event.type === "output") observeOutput(event.data);
        applyEvent(event);
      }
    : applyEvent;
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
