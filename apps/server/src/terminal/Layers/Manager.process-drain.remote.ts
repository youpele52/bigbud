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
  for (const session of runningSessions) {
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
      : (ctx.ptyAdapter?.ownedRuntimeForTarget?.(session.executionTargetId)?.targetId ??
        session.executionTargetId);
    const group = groups.get(target) ?? [];
    group.push({
      threadId: session.threadId,
      terminalId: session.terminalId,
      executionTargetId: session.executionTargetId,
      runtimeEpoch: session.runtimeEpoch,
      runtimeGeneration: session.runtimeGeneration,
      pid: session.pid,
      remotePid,
    });
    groups.set(target, group);
  }
  return Effect.forEach(
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
          yield* invalidateTerminalWorkAssessment(ctx, sessions);
          yield* pushOwnerHints(ctx, sessions, () => "unknown");
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
  ).pipe(Effect.andThen(ctx.refreshIdleWork ?? Effect.void));
}

type InspectedSession = {
  readonly threadId: string;
  readonly terminalId: string;
  readonly executionTargetId: string;
  readonly runtimeEpoch: number;
  readonly runtimeGeneration: string;
  readonly pid: number;
  readonly remotePid: number;
};

/**
 * Direct SSH owner hints (plan §8.5, M7): a host that runs the local ssh client cannot see the
 * remote foreground program, so each inspection pushes it. Sessions without host lifecycle
 * (in-process, an agent PTY) ignore it.
 */
function pushOwnerHints(
  ctx: ProcessLifecycleContext,
  sessions: ReadonlyArray<InspectedSession>,
  hint: (session: InspectedSession) => "busy" | "idle" | "unknown",
): Effect.Effect<void> {
  return ctx.modifyManagerState((state) => {
    for (const session of sessions) {
      const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
      if (
        current?.status === "running" &&
        current.pid === session.pid &&
        current.runtimeEpoch === session.runtimeEpoch &&
        current.runtimeGeneration === session.runtimeGeneration &&
        terminalRunsLocalSshClient(ctx.ptyAdapter, current.executionTargetId)
      )
        setTerminalOwnerBusyHint(current, hint(session), ctx.hostHub?.viewChanged);
    }
    return [undefined, state] as const;
  });
}
