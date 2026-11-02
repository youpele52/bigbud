import * as Effect from "effect/Effect";
import type {
  TerminalRecoveryInput,
  TerminalRecoveryResult,
} from "@bigbud/contracts/workspace/terminal.recovery.ts";
import type { TerminalSessionState } from "./Manager.types";

const unavailable = (reason: string): TerminalRecoveryResult => ({ type: "unavailable", reason });

/** Read-only fixed-cut recovery. Recheck ownership after asynchronous parsing; never reopen. */
export const captureTerminalRecovery = Effect.fn("terminal.captureRecovery")(function* (
  session: TerminalSessionState,
  input: TerminalRecoveryInput,
) {
  if (session.runtimeGeneration !== input.expectedGeneration)
    return unavailable("generation-mismatch");
  const model = session.recoveryModel;
  if (!model) return unavailable("recovery-not-enabled-for-session");
  if (model.unavailableReason) return unavailable(model.unavailableReason);
  if (input.after) return model.records.after(input.after);
  const result = yield* Effect.promise(() => model.capture());
  if (
    session.runtimeGeneration !== input.expectedGeneration ||
    session.recoveryModel !== model ||
    model.unavailableReason
  )
    return unavailable("generation-retired");
  return result.type === "candidate" ? { type: "snapshot" as const, frame: result.frame } : result;
});
