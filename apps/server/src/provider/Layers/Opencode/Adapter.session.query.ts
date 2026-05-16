/**
 * OpencodeAdapter session query/stop methods — `stopSession`, `listSessions`,
 * `hasSession`, `readThread`, `rollbackThread`, and `stopAll`.
 *
 * @module OpencodeAdapter.session.query
 */
import { type ProviderSession } from "@bigbud/contracts";
import { Effect } from "effect";

import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../../Errors.ts";
import type { OpencodeAdapterShape } from "../../Services/Opencode/Adapter.ts";
import { buildThreadSnapshot, toMessage } from "./Adapter.stream.ts";
import { PROVIDER } from "./Adapter.types.ts";
import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import type { QueryMethodDeps } from "./Adapter.session.ts";

// ── Stop helper ───────────────────────────────────────────────────────

export function makeStopSessionRecord(
  sessions: Map<string, ActiveOpencodeSession>,
): (record: ActiveOpencodeSession) => Effect.Effect<void, ProviderAdapterRequestError> {
  return (record) =>
    Effect.tryPromise({
      try: async () => {
        // Abort SSE stream
        record.sseAbortController?.abort();
        record.sseAbortController = null;

        // Clear pending permissions
        record.pendingPermissions.clear();

        // Clear pending user-input requests so the UI panel dismisses cleanly
        record.pendingUserInputs.clear();

        // Delete the session from OpenCode
        try {
          await record.client.session.delete({
            sessionID: record.opencodeSessionId,
          });
        } catch {
          // Best effort — session might already be gone
        }

        // Release the shared server handle (decrements ref-count; shuts down server when last session stops)
        record.releaseServer();
        await record.cleanupBridge?.();
        sessions.delete(record.threadId);
      },
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.stop",
          detail: toMessage(cause, "Failed to stop OpenCode session."),
          cause,
        }),
    });
}

// ── Query/stop method factories ───────────────────────────────────────

export function makeQueryMethods(deps: QueryMethodDeps) {
  const { sessions, requireSession, syntheticEventFn, emitFn } = deps;

  const stopSessionRecord = makeStopSessionRecord(sessions);

  const stopSession: OpencodeAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);

      // Drain any pending user-input requests — emit resolved events so the UI panel
      // dismisses cleanly instead of staying open after the session is gone.
      for (const [requestId, pending] of record.pendingUserInputs) {
        const resolvedEvent = yield* syntheticEventFn(
          threadId,
          "user-input.resolved",
          { answers: {} },
          {
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId,
          },
        );
        yield* emitFn([resolvedEvent]);
      }

      yield* stopSessionRecord(record);

      // Notify the orchestration pipeline that the session has exited
      yield* emitFn([
        yield* syntheticEventFn(threadId, "session.exited", {
          reason: "stopSession",
        }),
      ]);
    });

  const listSessions: OpencodeAdapterShape["listSessions"] = () =>
    Effect.succeed(
      Array.from(sessions.values()).map((record) => {
        return Object.assign(
          {
            provider: PROVIDER,
            status: record.activeTurnId ? ("running" as const) : ("ready" as const),
            runtimeMode: record.runtimeMode,
            ...(record.providerRuntimeExecutionTargetId
              ? { providerRuntimeExecutionTargetId: record.providerRuntimeExecutionTargetId }
              : {}),
            ...(record.workspaceExecutionTargetId
              ? { workspaceExecutionTargetId: record.workspaceExecutionTargetId }
              : {}),
            threadId: record.threadId,
            resumeCursor: { sessionId: record.opencodeSessionId },
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
          record.cwd ? { cwd: record.cwd } : undefined,
          record.model ? { model: record.model } : undefined,
          record.activeTurnId ? { activeTurnId: record.activeTurnId } : undefined,
          record.lastError ? { lastError: record.lastError } : undefined,
        ) satisfies ProviderSession;
      }),
    );

  const hasSession: OpencodeAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: OpencodeAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      return buildThreadSnapshot(threadId, record.turns);
    });

  const rollbackThread: OpencodeAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "OpenCode sessions do not support rolling back conversation state.",
      }),
    ).pipe(Effect.annotateLogs({ threadId }));

  const stopAll: OpencodeAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionRecord, {
      concurrency: "unbounded",
    }).pipe(Effect.asVoid);

  return { stopSession, listSessions, hasSession, readThread, rollbackThread, stopAll };
}
