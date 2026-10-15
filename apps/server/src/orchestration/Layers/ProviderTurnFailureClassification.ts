import type { TurnStartFailureClass } from "@bigbud/contracts/orchestration/orchestration.turnFailure.ts";
import { Cause, Schema } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { isProviderContextLimitError } from "./ProviderCommandReactorSessionOps.recovery.ts";
import {
  provenBeforeDispatch,
  TurnStartReclassifiedError,
  type TurnStartDispatchPhase,
} from "./ProviderCommandReactorSessionOps.recovery.dispatch.phase.ts";

const PROVIDER_BUSY_TURN_DETAIL =
  /already active|ongoing provider work|cannot start another turn|unresolved turn/i;
/** Refusals whose outcome is uncertain or that need user action (OpenCode V2 retirement texts). */
const UNSAFE_TO_REPLAY_DETAIL =
  /nothing was replayed|no replay|no automatic resend|retirement|settlement unconfirmed|still running|admission may be unconfirmed/i;
const AUTH_OR_QUOTA_DETAIL =
  /\b(?:401|402|403|429)\b|unauthori[sz]ed|forbidden|not authenticated|not logged in|login required|invalid api key|api key (?:is )?(?:missing|invalid)|quota|rate.?limit|insufficient (?:credit|balance|funds)|billing|usage limit/i;
/**
 * The provider cannot run at all: binary missing or not executable, or disabled in settings.
 * Checked before typed process errors, which would otherwise read as a dead session (D18).
 */
const PROVIDER_UNAVAILABLE_DETAIL =
  /\bspawn\b[^\n]*\b(?:ENOENT|EACCES)\b|is not installed|not (?:available )?on PATH|executable (?:file )?not found|command not found|is disabled in bigbud settings/i;
/** Provider recovery refusals: the live session is gone and cannot be resumed in place. */
const SESSION_RECOVERY_REFUSED_DETAIL =
  /cannot recover thread|does not support session recovery|no provider resume state/i;
const SESSION_DEAD_DETAIL =
  /session (?:is )?(?:closed|not found|terminated|ended|expired)|unknown (?:provider |adapter )?(?:session|thread)|thread is closed|process (?:'[^']*' )?(?:has )?exited|no longer writable|connection (?:is |was |has been )?(?:closed|disposed|lost)|transport (?:is )?closed|broken pipe|\bEPIPE\b|\bECONNRESET\b|\bECONNREFUSED\b|socket hang up/i;

const isTypedSessionDead = (error: unknown) =>
  Schema.is(ProviderAdapterSessionNotFoundError)(error) ||
  Schema.is(ProviderAdapterSessionClosedError)(error) ||
  Schema.is(ProviderAdapterProcessError)(error) ||
  Schema.is(ProviderSessionNotFoundError)(error);

const isValidationError = (error: unknown) =>
  Schema.is(ProviderAdapterValidationError)(error) || Schema.is(ProviderValidationError)(error);

const failureText = (error: unknown): string => {
  if (Schema.is(ProviderAdapterValidationError)(error) || Schema.is(ProviderValidationError)(error))
    return error.issue;
  if (
    Schema.is(ProviderAdapterRequestError)(error) ||
    Schema.is(ProviderAdapterProcessError)(error)
  )
    return error.detail;
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
};

/** Every provider adapter error may carry the adapter's own class. */
const explicitFailureClass = (error: unknown): TurnStartFailureClass | undefined =>
  error instanceof TurnStartReclassifiedError
    ? error.failureClass
    : Schema.is(ProviderAdapterSessionNotFoundError)(error) ||
        Schema.is(ProviderAdapterSessionClosedError)(error) ||
        Schema.is(ProviderAdapterProcessError)(error) ||
        Schema.is(ProviderAdapterValidationError)(error) ||
        Schema.is(ProviderAdapterRequestError)(error)
      ? error.failureClass
      : undefined;

/**
 * Classifies a turn-start failure (a `Cause` or an error value). The adapter's explicit class
 * wins; then texts that must never be auto-recovered; then typed errors; then fallbacks.
 *
 * With a dispatch phase, a `session-dead` failure after dispatch that is not proven to precede it
 * is `unsafe-to-replay`, so the result is never resendable for a turn the provider may have
 * accepted. Without a phase the failure is classified as is.
 */
export function classifyTurnStartFailure(
  failure: unknown,
  phase?: TurnStartDispatchPhase,
): TurnStartFailureClass {
  const error = Cause.isCause(failure) ? Cause.squash(failure) : failure;
  const failureClass = classifyError(error);
  if (failureClass !== "session-dead" || phase === undefined || !phase.dispatched) {
    return failureClass;
  }
  return provenBeforeDispatch(error, phase) ? "session-dead" : "unsafe-to-replay";
}

function classifyError(error: unknown): TurnStartFailureClass {
  const explicit = explicitFailureClass(error);
  if (explicit !== undefined) return explicit;
  const text = failureText(error);
  if (PROVIDER_BUSY_TURN_DETAIL.test(text)) return "busy";
  if (UNSAFE_TO_REPLAY_DETAIL.test(text)) return "unsafe-to-replay";
  if (AUTH_OR_QUOTA_DETAIL.test(text)) return "auth-or-quota";
  if (PROVIDER_UNAVAILABLE_DETAIL.test(text)) return "provider-unavailable";
  if (isProviderContextLimitError(error)) return "context-limit";
  if (isTypedSessionDead(error)) return "session-dead";
  if (SESSION_RECOVERY_REFUSED_DETAIL.test(text)) return "session-dead";
  if (isValidationError(error)) return "invalid-request";
  if (SESSION_DEAD_DETAIL.test(text)) return "session-dead";
  return "unknown";
}

/** True when a turn start failed because the provider is still running another turn. */
export function isProviderTurnBusyCause(cause: Cause.Cause<unknown>): boolean {
  return classifyTurnStartFailure(cause) === "busy";
}
