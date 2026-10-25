import { Schema } from "effect";

/**
 * Typed reason a provider turn could not start. Adapters set it where they know the class;
 * the server falls back to message patterns. Optional on the wire: older events decode as
 * unclassified (treated as "unknown").
 *
 * - busy: the provider is still running a turn; the prompt is queued.
 * - context-limit: the session's context window is full.
 * - session-dead: the provider session/process/transport is gone; in-place recovery may run.
 * - auth-or-quota: authentication, authorization, quota or billing; never auto-recovered.
 * - invalid-request: the request itself is invalid; never auto-recovered.
 * - unsafe-to-replay: automatic action is unsafe (outcome may be uncertain); user action needed.
 * - provider-unavailable: the provider binary is missing or not executable, or the provider is
 *   disabled; never auto-recovered or auto-forked (the user may continue in a new thread).
 * - unknown: none of the above.
 */
export const TurnStartFailureClass = Schema.Literals([
  "busy",
  "context-limit",
  "session-dead",
  "auth-or-quota",
  "invalid-request",
  "unsafe-to-replay",
  "provider-unavailable",
  "unknown",
]);
export type TurnStartFailureClass = typeof TurnStartFailureClass.Type;
