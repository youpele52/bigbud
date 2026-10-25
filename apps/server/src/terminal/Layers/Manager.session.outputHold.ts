import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { toSessionKey } from "./Manager.shell";
import type { SessionApiContext } from "./Manager.session.types.ts";
import type { TerminalManagerShape } from "../Services/Manager";

/**
 * Producer flow control. A terminal's PTY stops being read while any delivery subscriber holds
 * it (its unsent output passed the high-water mark) and resumes when the last hold is released.
 * Holds are idempotent per holder and re-applied by the holder after a restart spawns a process.
 */
export function makeTerminalOutputHold(
  getSession: SessionApiContext["getSession"],
): NonNullable<TerminalManagerShape["setOutputHold"]> {
  const holders = new Map<string, Set<string>>();
  return (input) =>
    Effect.gen(function* () {
      const key = toSessionKey(input.threadId, input.terminalId);
      const current = holders.get(key) ?? new Set<string>();
      if (input.held) current.add(input.holderId);
      else current.delete(input.holderId);
      if (current.size > 0) holders.set(key, current);
      else holders.delete(key);
      const session = yield* getSession(input.threadId, input.terminalId);
      if (Option.isNone(session) || !session.value.process) return false;
      const process = session.value.process;
      if (!process.pause || !process.resume) return false;
      if (current.size > 0) process.pause();
      else process.resume();
      return true;
    });
}
