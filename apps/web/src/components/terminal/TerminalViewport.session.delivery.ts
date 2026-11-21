import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";
import { TerminalHistoryUnavailableError } from "./TerminalHistoryUnavailableError";
import { createTerminalViewportDelivery } from "./TerminalViewport.delivery";
import type { TerminalView } from "./TerminalViewport.view";
import type { UseTerminalViewportSessionInput } from "./TerminalViewport.session.types";

export type TerminalViewportDelivery = ReturnType<typeof createTerminalViewportDelivery>;

/** The view-side hooks one delivery lane reports to; late-bound so lanes can be replaced. */
export interface TerminalViewportDeliveryContext {
  readonly view: TerminalView;
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly input: Pick<UseTerminalViewportSessionInput, "hasHandledExitRef" | "dropPathModeRef">;
  readonly readInput: () => UseTerminalViewportSessionInput;
  readonly disposed: () => boolean;
  readonly clearSelectionAction: () => void;
  readonly onSnapshot: (snapshot: TerminalSessionSnapshot) => boolean | void;
  readonly output: { readonly unsubscribe: () => void; readonly parsed: () => void };
  readonly onScreenApplied: () => void;
  readonly setInputEnabled: (enabled: boolean) => void;
  readonly setHistoryUnavailable: (unavailable: boolean) => void;
  readonly setDeliveryError: (message: string) => void;
  readonly onLiveAttach: () => void;
  readonly onStalled: () => void;
}

/** Builds a fresh delivery lane for the view; replacing a lane never rebuilds the emulator. */
export function makeTerminalViewportDeliveryFactory(context: TerminalViewportDeliveryContext) {
  const { view, disposed, output } = context;
  const { instrumentation } = view;
  return (): TerminalViewportDelivery => {
    const next = createTerminalViewportDelivery({
      terminalRef: context.terminalRef,
      hasHandledExitRef: context.input.hasHandledExitRef,
      dropPathModeRef: context.input.dropPathModeRef,
      clearSelectionAction: context.clearSelectionAction,
      handleSessionExited: () => context.readInput().onSessionExited(),
      onSnapshot: (snapshot) => context.onSnapshot(snapshot),
      onInputState: (enabled) => {
        if (disposed()) return;
        context.setInputEnabled(enabled);
        if (enabled) context.setHistoryUnavailable(false);
      },
      onFailure: (error) => {
        // A stopped lane never acknowledges; release the stream so the PTY is not held.
        output.unsubscribe();
        if (disposed()) return;
        context.setDeliveryError(error.message);
        if (error instanceof TerminalHistoryUnavailableError) context.setHistoryUnavailable(true);
      },
      observeOutput: instrumentation.observeOutput,
      onLiveAttach: context.onLiveAttach,
      onScreenApplied: context.onScreenApplied,
      onCreditReleased: () => output.parsed(),
      batcherOptions: {
        ...view.pipeline.batcherOptions,
        isLatencySensitive: instrumentation.isLatencySensitive,
        onParsed: () => output.parsed(),
        onStalled: () => {
          if (!disposed()) context.onStalled();
        },
      },
    });
    instrumentation.bindWriteBatcher(next.writeBatcher);
    return next;
  };
}
