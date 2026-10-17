/**
 * Dispatch phase of a turn-start attempt (a turn must never be sent twice).
 *
 * Recovery may resend only a `session-dead` failure that provably happened before the provider
 * could have accepted the turn: raised before the provider send was invoked (session start,
 * settings, routing), raised by provider routing before any adapter dispatch, or explicitly marked
 * `session-dead` by the adapter (which knows its own dispatch point). Any other `session-dead`
 * failure (a connection reset, closed transport or process exit while sending) may have been
 * accepted; it is reported `unsafe-to-replay` and never resent or auto-forked.
 *
 * @module ProviderCommandReactorSessionOps.recovery.dispatch
 */
import { Schema } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../provider/Errors.ts";
import {
  provenBeforeDispatch,
  TurnStartReclassifiedError,
  type TurnStartDispatchPhase,
} from "./ProviderCommandReactorSessionOps.recovery.dispatch.phase.ts";
import { classifyTurnStartFailure } from "./ProviderTurnFailureClassification.ts";

/** True only for a `session-dead` failure proven to precede dispatch. */
export function isResendableTurnStartFailure(
  error: unknown,
  phase: TurnStartDispatchPhase,
): boolean {
  return classifyTurnStartFailure(error) === "session-dead" && provenBeforeDispatch(error, phase);
}

/**
 * Reports a failure with its phase-aware class (`classifyTurnStartFailure(error, phase)`), so an
 * unproven `session-dead` after dispatch is recorded `unsafe-to-replay`. Adapter errors carry the
 * class themselves; any other error is wrapped in `TurnStartReclassifiedError`.
 */
export function reportUnprovenSessionDead<E>(error: E, phase: TurnStartDispatchPhase): E {
  const failureClass = classifyTurnStartFailure(error, phase);
  if (failureClass === classifyTurnStartFailure(error)) return error;
  if (Schema.is(ProviderAdapterRequestError)(error))
    return new ProviderAdapterRequestError({ ...error, failureClass }) as E;
  if (Schema.is(ProviderAdapterProcessError)(error))
    return new ProviderAdapterProcessError({ ...error, failureClass }) as E;
  if (Schema.is(ProviderAdapterSessionClosedError)(error))
    return new ProviderAdapterSessionClosedError({ ...error, failureClass }) as E;
  if (Schema.is(ProviderAdapterSessionNotFoundError)(error))
    return new ProviderAdapterSessionNotFoundError({ ...error, failureClass }) as E;
  if (Schema.is(ProviderAdapterValidationError)(error))
    return new ProviderAdapterValidationError({ ...error, failureClass }) as E;
  const message = error instanceof Error ? error.message : String(error);
  return new TurnStartReclassifiedError({ message, failureClass, cause: error }) as E;
}
