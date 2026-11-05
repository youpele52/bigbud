import { Effect, Option } from "effect";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { detectTerminalAgentForShell } from "./Manager.agentDetection.ts";
import { applyAgentIdentitiesWith } from "./Manager.process-drain.identity.ts";
import { inspectRemoteTerminalProcesses } from "./Manager.remote-inspection.ts";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import type { TerminalSessionState } from "./Manager.types.ts";
import { toSessionKey } from "./Manager.shell.ts";
import { nextTerminalTimestamp } from "./Manager.session.timestamp.ts";

export function pollRemoteProcessesWith(
  ctx: ProcessLifecycleContext,
  runningSessions: ReadonlyArray<TerminalSessionState & { pid: number }>,
): Effect.Effect<void> {
  // Copy evidence before awaiting: session objects are mutable and PIDs can be reused on restart.
  const groups = new Map<
    string,
    Array<{
      threadId: string;
      terminalId: string;
      executionTargetId: string;
      runtimeEpoch: number;
      runtimeGeneration: string;
      pid: number;
      remotePid: number;
    }>
  >();
  for (const session of runningSessions) {
    if (
      isLocalExecutionTarget(session.executionTargetId) ||
      isWslTerminalTargetId(session.executionTargetId)
    )
      continue;
    const remotePid =
      session.process?.pidDomain === "remote" ? session.pid : session.remoteShellPid;
    if (!remotePid || !Number.isSafeInteger(remotePid) || remotePid <= 1) continue;
    const group = groups.get(session.executionTargetId) ?? [];
    group.push({
      threadId: session.threadId,
      terminalId: session.terminalId,
      executionTargetId: session.executionTargetId,
      runtimeEpoch: session.runtimeEpoch,
      runtimeGeneration: session.runtimeGeneration,
      pid: session.pid,
      remotePid,
    });
    groups.set(session.executionTargetId, group);
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
        if (Option.isNone(result)) return;
        const processes = result.value;
        const pids = new Set(processes.map((process) => process.pid));
        for (const session of sessions) {
          // Missing shell is not proof of idle (e.g. a transient remote process visibility failure).
          if (!pids.has(session.remotePid)) continue;
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
              current.executionTargetId !== session.executionTargetId ||
              current.hasRunningSubprocess === active
            )
              return [null, state] as const;
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
}
