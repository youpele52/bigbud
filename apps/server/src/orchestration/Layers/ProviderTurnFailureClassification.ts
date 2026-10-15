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

const PROVIDER_BUSY_TURN_DETAIL =
  /already active|ongoing provider work|cannot start another turn|unresolved turn/i;
/** Refusals whose outcome is uncertain or that need user action (OpenCode V2 retirement texts). */
const UNSAFE_TO_REPLAY_DETAIL =
  /nothing was replayed|no replay|no automatic resend|retirement|settlement unconfirmed|still running|admission may be unconfirmed/i;
const AUTH_OR_QUOTA_DETAIL =
  /\b(?:401|402|403|429)\b|unauthori[sz]ed|forbidden|not authenticated|not logged in|login required|invalid api key|api key (?:is )?(?:missing|invalid)|quota|rate.?limit|insufficient (?:credit|balance|funds)|billing|usage limit/i;
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
  Schema.is(ProviderAdapterSessionNotFoundError)(error) ||
  Schema.is(ProviderAdapterSessionClosedError)(error) ||
  Schema.is(ProviderAdapterProcessError)(error) ||
  Schema.is(ProviderAdapterValidationError)(error) ||
  Schema.is(ProviderAdapterRequestError)(error)
    ? error.failureClass
    : undefined;

/**
 * Classifies a turn-start failure (a `Cause` or an error value). The adapter's explicit class
 * wins; then texts that must never be auto-recovered; then typed errors; then fallbacks.
 */
export function classifyTurnStartFailure(failure: unknown): TurnStartFailureClass {
  const error = Cause.isCause(failure) ? Cause.squash(failure) : failure;
  const explicit = explicitFailureClass(error);
  if (explicit !== undefined) return explicit;
  const text = failureText(error);
  if (PROVIDER_BUSY_TURN_DETAIL.test(text)) return "busy";
  if (UNSAFE_TO_REPLAY_DETAIL.test(text)) return "unsafe-to-replay";
  if (AUTH_OR_QUOTA_DETAIL.test(text)) return "auth-or-quota";
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
