/**
 * Dispatch phase of a turn-start attempt, shared by the failure classifier and the recovery
 * dispatch rules (no import cycle between them).
 *
 * A failure is proven to precede dispatch when it was raised before the provider send was invoked,
 * by provider routing before any adapter dispatch, by a failed `may-have-been-sent` write (which
 * stops the send), or when the adapter explicitly marked it `session-dead` (the adapter knows
 * its own dispatch point).
 *
 * @module ProviderCommandReactorSessionOps.recovery.dispatch.phase
 */
import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Data, Schema } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderDispatchAttemptPersistenceError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../../provider/Errors.ts";

/** Per attempt; `dispatched` is set immediately before the provider send is invoked. */
export interface TurnStartDispatchPhase {
  dispatched: boolean;
}

export const newTurnStartDispatchPhase = (): TurnStartDispatchPhase => ({ dispatched: false });

/**
 * A non-adapter failure whose class was reassessed after dispatch (for example a plain
 * dead-connection error). It carries the reported class so the recorded failure never reads as
 * resendable; `message` keeps the original detail.
 */
export class TurnStartReclassifiedError extends Data.TaggedError("TurnStartReclassifiedError")<{
  readonly message: string;
  readonly failureClass: TurnStartFailureClass;
  readonly cause: unknown;
}> {}

const adapterMarkedSessionDead = (error: unknown) =>
  (Schema.is(ProviderAdapterRequestError)(error) ||
    Schema.is(ProviderAdapterProcessError)(error) ||
    Schema.is(ProviderAdapterSessionClosedError)(error) ||
    Schema.is(ProviderAdapterSessionNotFoundError)(error) ||
    Schema.is(ProviderAdapterValidationError)(error)) &&
  error.failureClass === "session-dead";

export function provenBeforeDispatch(error: unknown, phase: TurnStartDispatchPhase): boolean {
  if (!phase.dispatched) return true;
  // Routing errors precede adapter dispatch; only the refusal texts classify as session-dead.
  if (Schema.is(ProviderSessionNotFoundError)(error) || Schema.is(ProviderValidationError)(error))
    return true;
  // The dispatch record could not be written, so the adapter send was never invoked.
  if (Schema.is(ProviderDispatchAttemptPersistenceError)(error)) return true;
  return adapterMarkedSessionDead(error);
}
