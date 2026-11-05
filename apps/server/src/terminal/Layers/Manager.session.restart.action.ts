import { createHash } from "node:crypto";
import { DEFAULT_TERMINAL_ID, resolveExecutionTargetId } from "@bigbud/contracts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { increment, terminalRestartsTotal } from "../../observability/Metrics";
import { makeResolveTerminalFolder } from "./Manager.cwd";
import { defaultTerminalDropPathMode, normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS, type TerminalSessionState } from "./Manager.types";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types";
import { assertTerminalGeneration } from "./Manager.session.generation";

export function makeTerminalRestart(ctx: SessionApiContext): TerminalManagerShape["restart"] {
  const resolveFolder = makeResolveTerminalFolder(
    ctx.assertValidCwd,
    undefined,
    undefined,
    ctx.resolveRuntimePathIdentity,
  );
  return (request) => {
    let reserved: TerminalSessionState | undefined;
    return ctx.withThreadLock(
      request.threadId,
      Effect.gen(function* () {
        const terminalId = request.terminalId ?? DEFAULT_TERMINAL_ID;
        const executionTargetId = resolveExecutionTargetId(request.executionTargetId);
        const existing = yield* ctx.getSession(request.threadId, terminalId);
        if (Option.isSome(existing)) {
          reserved = existing.value;
          reserved.lifecyclePending = true;
        }
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([
              request.cwd,
              request.worktreePath,
              executionTargetId,
              request.cols,
              request.rows,
              Object.entries(request.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
              request.expectedGeneration,
            ]),
          )
          .digest("hex");
        if (Option.isSome(existing)) {
          const session = existing.value;
          const prior = session.lastRestartOperation;
          if (
            request.operationId &&
            prior?.id === request.operationId &&
            prior.generation === session.runtimeGeneration
          ) {
            if (prior.fingerprint !== fingerprint) {
              return yield* new TerminalExecutionTargetError({
                threadId: request.threadId,
                terminalId,
                executionTargetId,
                detail: "Restart operation identity was reused with different parameters.",
              });
            }
            return ctx.snapshot(session);
          }
          yield* assertTerminalGeneration(session, request.expectedGeneration);
        } else if (request.expectedGeneration !== undefined) {
          return yield* new TerminalExecutionTargetError({
            threadId: request.threadId,
            terminalId,
            executionTargetId,
            detail:
              "The previous terminal session is no longer available; no replacement was started.",
          });
        }
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        // Resolve the target before terminating a working session.
        const folder = yield* resolveFolder({
          threadId: request.threadId,
          terminalId,
          executionTargetId,
          cwd: request.cwd,
          worktreePath: request.worktreePath,
          env: request.env,
        });
        const input = {
          ...request,
          cwd: folder.cwd,
          ...(folder.wslIdentity ? { worktreePath: folder.worktreePath, env: folder.env } : {}),
          ...(folder.directoryFallback ? { worktreePath: null, env: undefined } : {}),
        };
        let session: TerminalSessionState;
        if (Option.isNone(existing)) {
          session = createTerminalSessionState({
            threadId: input.threadId,
            terminalId,
            executionTargetId,
            dropPathMode: defaultTerminalDropPathMode(executionTargetId),
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            history: "",
            cols: input.cols ?? DEFAULT_OPEN_COLS,
            rows: input.rows ?? DEFAULT_OPEN_ROWS,
            runtimeEnv: normalizedRuntimeEnv(input.env),
          });
          reserved = session;
          session.lifecyclePending = true;
          session.remoteOwnerRecoveryRequired = yield* ctx.historyExists(
            input.threadId,
            terminalId,
          );
          const created = session;
          yield* ctx.modifyManagerState((state) => {
            const sessions = new Map(state.sessions);
            sessions.set(toSessionKey(input.threadId, terminalId), created);
            return [undefined, { ...state, sessions }] as const;
          });
          yield* ctx.evictInactiveSessionsIfNeeded();
        } else {
          session = existing.value;
          yield* ctx.flushPtyOutput(session.threadId, session.terminalId);
          yield* ctx.stopProcess(session);
          session.executionTargetId = executionTargetId;
          session.dropPathMode = defaultTerminalDropPathMode(executionTargetId);
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
        }
        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;
        session.directoryFallback = folder.directoryFallback;
        session.wslIdentity = folder.wslIdentity;
        yield* ctx.acquireWorktreeLease({
          runtimePathIdentity: folder.runtimePathIdentity,
          threadId: input.threadId,
          terminalId,
          executionTargetId,
          cwd: input.cwd,
          worktreePath: session.worktreePath,
        });
        // Retain only the existing bounded transcript while attempting the replacement.
        const previous = {
          history: session.history,
          historyTruncated: session.historyTruncated,
          historyUnavailable: session.historyUnavailable,
          historyBytes: session.historyBytes,
          historyNewlines: session.historyNewlines,
          historyTail: session.historyTail,
        };
        resetSessionRuntimeState(session);
        yield* ctx
          .startSession(
            session,
            {
              threadId: input.threadId,
              terminalId,
              executionTargetId,
              cwd: input.cwd,
              ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
              cols,
              rows,
              ...(input.env ? { env: input.env } : {}),
            },
            "restarted",
          )
          .pipe(
            Effect.onError(() =>
              ctx.releaseWorktreeLease({ threadId: input.threadId, terminalId }),
            ),
          );
        if (session.status !== "running") Object.assign(session, previous);
        yield* ctx.persistHistory(input.threadId, terminalId, session.history);
        if (session.pid !== null) {
          yield* ctx.markWorktreeLeaseStarted({
            threadId: input.threadId,
            terminalId,
            processId: session.pid,
          });
        }
        if (request.operationId)
          session.lastRestartOperation = {
            id: request.operationId,
            fingerprint,
            generation: session.runtimeGeneration,
          };
        return ctx.snapshot(session);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (reserved) reserved.lifecyclePending = false;
          }),
        ),
      ),
    );
  };
}
