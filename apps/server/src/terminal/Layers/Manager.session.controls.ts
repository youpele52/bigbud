import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts";
import { Effect } from "effect";
import { TerminalNotRunningError } from "../Services/Manager.ts";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types.ts";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import { assertTerminalGeneration } from "./Manager.session.generation";

export function makeTerminalSessionControls(requireSession: SessionApiContext["requireSession"]) {
  const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const session = yield* requireSession(input.threadId, terminalId);
    yield* assertTerminalGeneration(session, input.expectedGeneration);
    const proc = session.process;
    if (session.stopPending)
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    if (!proc || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    }
    yield* Effect.try({
      try: () => proc.write(input.data),
      // The process can exit between the status check and the native write.
      catch: () => new TerminalNotRunningError({ threadId: input.threadId, terminalId }),
    });
  });
  const resize: TerminalManagerShape["resize"] = Effect.fn("terminal.resize")(function* (input) {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const session = yield* requireSession(input.threadId, terminalId);
    const proc = session.process;
    if (!proc || session.status !== "running")
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = nextTerminalTimestamp(session.updatedAt);
    yield* Effect.try({
      try: () => proc.resize(input.cols, input.rows),
      // Resizing a PTY whose descriptor closed on exit throws natively.
      catch: () => new TerminalNotRunningError({ threadId: input.threadId, terminalId }),
    });
  });
  return { write, resize };
}
