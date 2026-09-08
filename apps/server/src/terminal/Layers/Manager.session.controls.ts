import { DEFAULT_TERMINAL_ID } from "@bigbud/contracts";
import { Effect } from "effect";
import { TerminalNotRunningError } from "../Services/Manager.ts";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types.ts";

export function makeTerminalSessionControls(requireSession: SessionApiContext["requireSession"]) {
  const write: TerminalManagerShape["write"] = Effect.fn("terminal.write")(function* (input) {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const session = yield* requireSession(input.threadId, terminalId);
    const proc = session.process;
    if (!proc || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    }
    yield* Effect.sync(() => proc.write(input.data));
  });
  const resize: TerminalManagerShape["resize"] = Effect.fn("terminal.resize")(function* (input) {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const session = yield* requireSession(input.threadId, terminalId);
    const proc = session.process;
    if (!proc || session.status !== "running")
      return yield* new TerminalNotRunningError({ threadId: input.threadId, terminalId });
    session.cols = input.cols;
    session.rows = input.rows;
    session.updatedAt = new Date().toISOString();
    yield* Effect.sync(() => proc.resize(input.cols, input.rows));
  });
  return { write, resize };
}
