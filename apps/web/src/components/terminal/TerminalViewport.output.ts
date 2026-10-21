import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalStreamDiagnostics } from "./TerminalDiagnostics";
import { subscribeTerminalOutput, type TerminalOutputSubscription } from "./TerminalOutputStream";

/** A view's subscription to its terminal's scoped stream, following delivery-lane replacement. */
export function createTerminalViewportOutput(input: {
  readonly threadId: string;
  readonly terminalId: string;
  readonly receive: (event: TerminalEvent) => void;
  readonly outstanding: () => number;
  readonly onResync: () => void;
}) {
  let subscription: TerminalOutputSubscription | null = null;
  return {
    /** Idempotent; resolves when the server registered the stream (before any open request). */
    subscribe(): Promise<void> {
      subscription ??= subscribeTerminalOutput(input.threadId, input.terminalId, {
        onEvent: input.receive,
        outstanding: input.outstanding,
        onResync: input.onResync,
      });
      return subscription.ready;
    },
    /** Also releases this view's share of producer flow control. */
    unsubscribe(): void {
      subscription?.unsubscribe();
      subscription = null;
    },
    parsed(): void {
      subscription?.parsed();
    },
    diagnostics(): TerminalStreamDiagnostics | null {
      return subscription?.diagnostics() ?? null;
    },
  };
}
