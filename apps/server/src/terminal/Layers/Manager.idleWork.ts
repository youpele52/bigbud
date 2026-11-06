import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import type { TerminalIdleWork } from "../Services/Manager.ts";
import * as Effect from "effect/Effect";
import { toSessionKey } from "./Manager.shell.ts";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

// The longest supported automatic rule is 30 days. Retain completion barriers for both rules,
// even when the sweeper is restarted or a pane is closed/evicted in the meantime.
const RETENTION_MS = 30 * 24 * 60 * 60_000;

export function terminalPaneWork(session: TerminalSessionState): TerminalIdleWork["state"] {
  if (
    session.remoteOwnerRecoveryRequired ||
    session.restartPreparation ||
    session.restartPending ||
    session.stopPending ||
    session.lifecyclePending
  )
    return "unknown";
  if (session.status === "starting") return "unknown";
  if (!session.process && session.status !== "running") return "idle";
  if (session.activeAgent || session.activeAgentProvider || session.hasRunningSubprocess)
    return "busy";
  if (
    !isLocalExecutionTarget(session.executionTargetId) &&
    !isWslTerminalTargetId(session.executionTargetId) &&
    session.process?.pidDomain !== "remote" &&
    !session.remoteShellPid
  )
    return "unknown";
  if (
    session.status !== "running" ||
    session.subprocessAssessedGeneration !== session.runtimeGeneration ||
    session.subprocessAssessedEpoch !== session.runtimeEpoch
  )
    return "unknown";
  return "idle";
}

/** One server-session owner. No output timestamps, persistence, or OS inspection. */
export function makeTerminalIdleWorkTracker(now: () => number = Date.now) {
  const threads = new Map<string, TerminalIdleWork>();
  const refreshThread = (threadId: string, sessions: Iterable<TerminalSessionState>) => {
    let state: TerminalIdleWork["state"] = "idle";
    for (const session of sessions) {
      const pane = terminalPaneWork(session);
      state =
        state === "busy" || pane === "busy"
          ? "busy"
          : state === "unknown" || pane === "unknown"
            ? "unknown"
            : "idle";
    }
    const previous = threads.get(threadId);
    const timestamp = now();
    const quietSince =
      previous && previous.state !== "idle" && state === "idle"
        ? timestamp
        : (previous?.quietSince ?? null);
    if (state === "idle" && (quietSince === null || timestamp - quietSince > RETENTION_MS)) {
      threads.delete(threadId);
    } else threads.set(threadId, { state, quietSince });
  };
  // Full reconciliation/retention pruning is only for the existing shared poll pass.
  const refresh = (sessions: Iterable<TerminalSessionState>) => {
    const panes = new Map<string, TerminalSessionState[]>();
    for (const session of sessions) {
      const group = panes.get(session.threadId) ?? [];
      group.push(session);
      panes.set(session.threadId, group);
    }
    for (const threadId of new Set([...threads.keys(), ...panes.keys()])) {
      refreshThread(threadId, panes.get(threadId) ?? []);
    }
  };
  return {
    refresh,
    refreshThread,
    snapshot: (): ReadonlyMap<string, TerminalIdleWork> => new Map(threads),
    get: (threadId: string): TerminalIdleWork =>
      threads.get(threadId) ?? { state: "idle", quietSince: null },
    forget: (threadId: string) => {
      threads.delete(threadId);
    },
  };
}

export function invalidateTerminalWorkAssessment(
  ctx: Pick<
    ProcessLifecycleContext,
    "modifyManagerState" | "refreshIdleWork" | "refreshThreadIdleWork"
  >,
  sessions: ReadonlyArray<
    Pick<
      TerminalSessionState,
      "threadId" | "terminalId" | "runtimeGeneration" | "runtimeEpoch" | "pid" | "executionTargetId"
    >
  >,
) {
  return ctx
    .modifyManagerState((state) => {
      for (const expected of sessions) {
        const current = state.sessions.get(toSessionKey(expected.threadId, expected.terminalId));
        if (
          current &&
          current.runtimeGeneration === expected.runtimeGeneration &&
          current.runtimeEpoch === expected.runtimeEpoch &&
          current.pid === expected.pid &&
          current.executionTargetId === expected.executionTargetId
        ) {
          current.subprocessAssessedGeneration = undefined;
        }
      }
      return [undefined, state] as const;
    })
    .pipe(
      Effect.andThen(
        ctx.refreshThreadIdleWork
          ? Effect.forEach(
              new Set(sessions.map((session) => session.threadId)),
              ctx.refreshThreadIdleWork,
              { discard: true },
            )
          : (ctx.refreshIdleWork ?? Effect.void),
      ),
    );
}

export function terminalWorkAllowsIdle(work: TerminalIdleWork, cutoffMs: number): boolean {
  return work.state === "idle" && (work.quietSince === null || work.quietSince <= cutoffMs);
}
