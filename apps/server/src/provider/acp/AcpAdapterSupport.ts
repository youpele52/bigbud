import { type ProviderApprovalDecision, type ProviderKind, type ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";

export function mapAcpToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

/**
 * Fails with a `session-dead` error when the agent process exit was already observed before the
 * prompt is dispatched: the turn never started, so bounded in-place recovery may run.
 */
export function assertAcpAgentAliveBeforePrompt(
  provider: ProviderKind,
  threadId: ThreadId,
  runtime: { readonly isAlive: Effect.Effect<boolean> },
): Effect.Effect<void, ProviderAdapterSessionClosedError> {
  return runtime.isAlive.pipe(
    Effect.flatMap((alive) =>
      alive
        ? Effect.void
        : Effect.fail(
            new ProviderAdapterSessionClosedError({
              provider,
              threadId,
              failureClass: "session-dead",
            }),
          ),
    ),
  );
}

/**
 * Maps an ACP prompt failure. The process was alive when the prompt was dispatched, so an exit
 * leaves the turn's outcome uncertain: classify it `unsafe-to-replay` so it is never auto-resent.
 */
export function mapAcpPromptToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  return Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)
    ? new ProviderAdapterSessionClosedError({
        provider,
        threadId,
        failureClass: "unsafe-to-replay",
        cause: error,
      })
    : mapAcpToAdapterError(provider, threadId, method, error);
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/**
 * Stopping an ACP session waits for its agent to exit, up to `ACP_CHILD_FORCE_KILL_AFTER` (2 s)
 * when it ignores SIGTERM. Stopping sessions one at a time made adapter teardown grow with the
 * session count; this bound keeps 16 sessions within one window while capping simultaneous work.
 */
export const ACP_SESSION_STOP_CONCURRENCY = 16;

/** Stop every session concurrently (bounded). Snapshots first: stopping removes map entries. */
export const stopAcpSessions = <Session, R>(
  sessions: Iterable<Session>,
  stopSession: (session: Session) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, R> =>
  Effect.forEach(Array.from(sessions), stopSession, {
    concurrency: ACP_SESSION_STOP_CONCURRENCY,
    discard: true,
  });
