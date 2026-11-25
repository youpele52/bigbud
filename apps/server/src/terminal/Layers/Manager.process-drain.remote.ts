import { Effect, Option } from "effect";
import { invalidateTerminalWorkAssessment } from "./Manager.idleWork.ts";
import {
  terminalPidIsOnBackendHost,
  terminalRunsLocalSshClient,
} from "./OwnedPtyRuntime.identity.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { detectTerminalAgentForShell } from "./Manager.agentDetection.ts";
import { applyAgentIdentitiesWith } from "./Manager.process-drain.identity.ts";
import {
  inspectRemoteTerminalProcesses,
  remoteOwnerBusyHint,
} from "./Manager.remote-inspection.ts";
import { setTerminalOwnerBusyHint } from "./Manager.hostPolicy.ts";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import type { TerminalSessionState } from "./Manager.types.ts";
import { toSessionKey } from "./Manager.shell.ts";
import { nextTerminalTimestamp } from "./Manager.session.timestamp.ts";

export function pollRemoteProcessesWith(
  ctx: ProcessLifecycleContext,
  runningSessions: ReadonlyArray<TerminalSessionState & { pid: number }>,
): Effect.Effect<void> {
  // Copy evidence before awaiting: session objects are mutable and PIDs can be reused on restart.
  const groups = new Map<string, Array<InspectedSession>>();
  const unavailable: InspectionIdentity[] = [];
  for (const session of runningSessions) {
    const runtime = ctx.ptyAdapter?.ownedRuntimeForTarget?.(session.executionTargetId);
    // The selected native owner has no typed process snapshot for this lease. Neither the
    // legacy SSH probe nor an in-band PID marker is evidence from that owner.
    if (runtime?.nativeSshWorkspaceRoot !== undefined) {
      unavailable.push(inspectionIdentity(session));
      continue;
    }
    if (
      terminalPidIsOnBackendHost(ctx.ptyAdapter, session.executionTargetId, session.process) ||
      isWslTerminalTargetId(session.executionTargetId)
    )
      continue;
    // A local ssh client (M7) is a host PID; its shell and inspection target are the target's.
    const sshClient = terminalRunsLocalSshClient(ctx.ptyAdapter, session.executionTargetId);
    const remotePid =
      session.process?.pidDomain === "remote" && !sshClient ? session.pid : session.remoteShellPid;
    if (!remotePid || !Number.isSafeInteger(remotePid) || remotePid <= 1) continue;
    const target = sshClient
      ? session.executionTargetId
      : (runtime?.targetId ?? session.executionTargetId);
    const group = groups.get(target) ?? [];
    group.push({ ...inspectionIdentity(session), remotePid });
    groups.set(target, group);
  }
  const inspectGroups = Effect.forEach(
    [...groups],
    ([target, sessions]) =>
      Effect.gen(function* () {
        const result = yield* (ctx.remoteProcessInspector ?? inspectRemoteTerminalProcesses)(
          target,
        ).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
        // Fail closed for inspection only: keep prior identity and do not interrupt the terminal.
        if (Option.isNone(result)) {
          yield* markInspectionUnavailable(ctx, sessions);
          return;
        }
        const processes = result.value;
        const pids = new Set(processes.map((process) => process.pid));
        yield* pushOwnerHints(ctx, sessions, (session) =>
          remoteOwnerBusyHint(session.remotePid, processes),
        );
        for (const session of sessions) {
          // Missing shell is not proof of idle (e.g. a transient remote process visibility failure).
          if (!pids.has(session.remotePid)) {
            yield* invalidateTerminalWorkAssessment(ctx, [session]);
            continue;
          }
          const detection = detectTerminalAgentForShell(session.remotePid, processes, "posix");
          yield* applyAgentIdentitiesWith(ctx, [session], new Map([[session.pid, detection]]));
          const active = processes.some((process) => process.parentPid === session.remotePid);
          const event = yield* ctx.modifyManagerState((state) => {
            const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
            if (
              !current ||
              current.status !== "running" ||
              current.pid !== session.pid ||
              current.runtimeEpoch !== session.runtimeEpoch ||
              current.runtimeGeneration !== session.runtimeGeneration ||
              current.executionTargetId !== session.executionTargetId
            )
              return [null, state] as const;
            current.subprocessAssessedGeneration = session.runtimeGeneration;
            current.subprocessAssessedEpoch = session.runtimeEpoch;
            if (current.hasRunningSubprocess === active) return [null, state] as const;
            current.hasRunningSubprocess = active;
            current.updatedAt = nextTerminalTimestamp(current.updatedAt);
            return [
              {
                type: "activity" as const,
                threadId: current.threadId,
                terminalId: current.terminalId,
                createdAt: current.updatedAt,
                hasRunningSubprocess: active,
              },
              state,
            ] as const;
          });
          if (event) yield* ctx.publishEvent(event);
        }
      }),
    { concurrency: 4, discard: true },
  );
  return (
    unavailable.length > 0
      ? markInspectionUnavailable(ctx, unavailable).pipe(Effect.andThen(inspectGroups))
      : inspectGroups
  ).pipe(Effect.andThen(ctx.refreshIdleWork ?? Effect.void));
}

function inspectionIdentity(session: TerminalSessionState & { pid: number }): InspectionIdentity {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    executionTargetId: session.executionTargetId,
    runtimeEpoch: session.runtimeEpoch,
    runtimeGeneration: session.runtimeGeneration,
    pid: session.pid,
  };
}

type InspectionIdentity = {
  readonly threadId: string;
  readonly terminalId: string;
  readonly executionTargetId: string;
  readonly runtimeEpoch: number;
  readonly runtimeGeneration: string;
  readonly pid: number;
};

type InspectedSession = InspectionIdentity & { readonly remotePid: number };

function markInspectionUnavailable(
  ctx: ProcessLifecycleContext,
  sessions: ReadonlyArray<InspectionIdentity>,
) {
  return invalidateTerminalWorkAssessment(ctx, sessions).pipe(
    Effect.andThen(pushOwnerHints(ctx, sessions, () => "unknown")),
  );
}

/**
 * Direct SSH owner hints (plan §8.5, M7): a host that runs the local ssh client cannot see the
 * remote foreground program, so each inspection pushes it. Sessions without host lifecycle
 * (in-process, an agent PTY) ignore it.
 */
function pushOwnerHints<A extends InspectionIdentity>(
  ctx: ProcessLifecycleContext,
  sessions: ReadonlyArray<A>,
  hint: (session: A) => "busy" | "idle" | "unknown",
): Effect.Effect<void> {
  return ctx.modifyManagerState((state) => {
    for (const session of sessions) {
      const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
      if (
        current?.status === "running" &&
        current.pid === session.pid &&
        current.runtimeEpoch === session.runtimeEpoch &&
        current.runtimeGeneration === session.runtimeGeneration &&
        current.executionTargetId === session.executionTargetId &&
        terminalRunsLocalSshClient(ctx.ptyAdapter, current.executionTargetId)
      )
        setTerminalOwnerBusyHint(current, hint(session), ctx.hostHub?.viewChanged);
    }
    return [undefined, state] as const;
  });
}
