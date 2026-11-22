/**
 * Open-path rules for host-backed terminals (plan S3, D1, D7): `attachOnly` never spawns, a
 * pane whose PTY the host lost opens read-only with its cold screen, and a live-limit refusal
 * fails the open with `TerminalLimitError` instead of leaving an errored pane behind.
 *
 * @module Manager.session.open.host
 */
import { resolveExecutionTargetId } from "@bigbud/contracts";
import { TerminalNotRunningError } from "@bigbud/contracts/workspace/terminal.ts";
import type {
  TerminalEndedReason,
  TerminalLimitError,
} from "@bigbud/contracts/workspace/terminal.limit.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { defaultTerminalDropPathMode, normalizedRuntimeEnv, toSessionKey } from "./Manager.shell";
import { TerminalHostOutputLedger } from "./Manager.hostScreen.ledger.ts";
import { toTerminalLimitError, type TerminalHostLimitContext } from "./Manager.hostLimit.ts";
import { createTerminalSessionState } from "./Manager.session.state.ts";
import type { SessionApiContext, TerminalManagerShape } from "./Manager.session.types.ts";
import { DEFAULT_OPEN_COLS, DEFAULT_OPEN_ROWS, type TerminalSessionState } from "./Manager.types";

type OpenRequest = Parameters<TerminalManagerShape["open"]>[0];

/**
 * `attachOnly` with no live process and no recoverable owner: return the retained session
 * as-is, open a host-lost pane read-only, or report that nothing runs. Never spawns.
 */
export const openTerminalAttachOnly = Effect.fn("terminal.openAttachOnly")(function* (input: {
  readonly ctx: SessionApiContext;
  readonly request: OpenRequest;
  readonly terminalId: string;
  readonly executionTargetId: string;
  readonly existing: Option.Option<TerminalSessionState>;
}) {
  const { ctx, request, terminalId } = input;
  if (Option.isSome(input.existing)) return ctx.snapshot(input.existing.value);
  const lost = ctx.hostLimit
    ?.roster()
    .find(
      (entry) =>
        entry.lost && entry.threadId === request.threadId && entry.terminalId === terminalId,
    );
  if (!lost) return yield* new TerminalNotRunningError({ threadId: request.threadId, terminalId });
  const session = createTerminalSessionState({
    threadId: request.threadId,
    terminalId,
    executionTargetId: input.executionTargetId,
    dropPathMode: defaultTerminalDropPathMode(input.executionTargetId),
    cwd: request.cwd,
    worktreePath: request.worktreePath ?? null,
    history: yield* ctx.readHistory(request.threadId, terminalId),
    cols: request.cols ?? DEFAULT_OPEN_COLS,
    rows: request.rows ?? DEFAULT_OPEN_ROWS,
    runtimeEnv: normalizedRuntimeEnv(request.env),
  });
  session.status = "exited";
  session.endedReason = "host-lost";
  // Only a cold screen remains: shown read-only, never restorable (§11.1).
  session.host = {
    generation: session.runtimeGeneration,
    ptyId: lost.ptyId,
    ledger: new TerminalHostOutputLedger(),
    screen: true,
    restorable: false,
    lifecycle: false,
  };
  yield* ctx.modifyManagerState((state) => {
    const sessions = new Map(state.sessions);
    sessions.set(toSessionKey(session.threadId, terminalId), session);
    return [undefined, { ...state, sessions }] as const;
  });
  return ctx.snapshot(session);
});

/**
 * The ended snapshot of a host-closed terminal the manager no longer retains (its tombstone):
 * nothing is spawned and nothing is retained again.
 */
export function endedTerminalSnapshot(
  ctx: SessionApiContext,
  request: OpenRequest,
  terminalId: string,
  reason: TerminalEndedReason,
) {
  const executionTargetId = resolveExecutionTargetId(request.executionTargetId);
  const session = createTerminalSessionState({
    threadId: request.threadId,
    terminalId,
    executionTargetId,
    dropPathMode: defaultTerminalDropPathMode(executionTargetId),
    cwd: request.cwd,
    worktreePath: request.worktreePath ?? null,
    history: "",
    cols: request.cols ?? DEFAULT_OPEN_COLS,
    rows: request.rows ?? DEFAULT_OPEN_ROWS,
    runtimeEnv: normalizedRuntimeEnv(request.env),
  });
  session.status = "exited";
  session.endedReason = reason;
  return ctx.snapshot(session);
}

/**
 * The host refused the spawn at its live limit: nothing was created, so a new session is
 * removed again, the runtime lease released, and the open fails with the host's candidate.
 */
export const rejectTerminalHostLimit = Effect.fn("terminal.rejectHostLimit")(function* (input: {
  readonly ctx: SessionApiContext;
  readonly session: TerminalSessionState;
  readonly created: boolean;
}): Effect.fn.Return<never, TerminalLimitError> {
  const { ctx, session } = input;
  const refusal = session.hostLimitRefusal!;
  session.hostLimitRefusal = undefined;
  if (input.created)
    yield* ctx.modifyManagerState((state) => {
      const key = toSessionKey(session.threadId, session.terminalId);
      if (state.sessions.get(key) !== session) return [undefined, state] as const;
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [undefined, { ...state, sessions }] as const;
    });
  yield* ctx.releaseWorktreeLease({ threadId: session.threadId, terminalId: session.terminalId });
  const limitContext: TerminalHostLimitContext = ctx.hostLimit ?? {
    sessions: () => Effect.succeed([]),
    roster: () => [],
    runtime: undefined,
  };
  return yield* yield* toTerminalLimitError(limitContext, refusal);
});
