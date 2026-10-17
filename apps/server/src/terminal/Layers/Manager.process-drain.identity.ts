import { Effect, Option } from "effect";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { toSessionKey } from "./Manager.shell";
import { nextTerminalTimestamp } from "./Manager.session.timestamp";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle";
import type { TerminalSessionState } from "./Manager.types";
import {
  normalizeTerminalAgentDetection,
  type TerminalAgentDetection,
} from "./Manager.agentDetection.ts";

function sameAgent(
  left: TerminalSessionState["activeAgent"],
  right: TerminalSessionState["activeAgent"],
) {
  return (
    left?.id === right?.id &&
    (left?.names.length ?? 0) === (right?.names.length ?? 0) &&
    (left?.names.every((name, index) => name === right?.names[index]) ?? true)
  );
}

export function pollAgentIdentityWith(
  ctx: ProcessLifecycleContext,
  runningSessions: ReadonlyArray<TerminalSessionState & { pid: number }>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const localSessions = runningSessions
      .filter((session) => isLocalExecutionTarget(session.executionTargetId))
      .map((session) => ({
        threadId: session.threadId,
        terminalId: session.terminalId,
        pid: session.pid,
        runtimeEpoch: session.runtimeEpoch,
      }));
    if (localSessions.length === 0) return;

    const result = yield* ctx.agentDetector(localSessions.map((session) => session.pid)).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.logWarning("failed to inspect terminal agent identity", {
          error: error.message,
        }).pipe(
          Effect.as(
            Option.none<
              ReadonlyMap<
                number,
                TerminalAgentDetection | TerminalSessionState["activeAgentProvider"]
              >
            >(),
          ),
        ),
      ),
    );
    if (Option.isNone(result)) return;

    for (const session of localSessions) {
      if (!result.value.has(session.pid)) continue;
      const detection = normalizeTerminalAgentDetection(result.value.get(session.pid) ?? null);
      const detectedProvider = detection?.provider ?? null;
      const detectedAgent = detection?.agent ?? null;
      const event = yield* ctx.modifyManagerState((managerState) => {
        const current = managerState.sessions.get(
          toSessionKey(session.threadId, session.terminalId),
        );
        if (
          !current ||
          current.status !== "running" ||
          current.pid !== session.pid ||
          current.runtimeEpoch !== session.runtimeEpoch
        ) {
          return [null, managerState] as const;
        }

        if (detection === null && (current.activeAgent || current.activeAgentProvider !== null)) {
          current.agentIdentityMisses += 1;
          if (current.agentIdentityMisses < 2) {
            return [null, managerState] as const;
          }
        } else {
          current.agentIdentityMisses = 0;
        }

        if (
          current.activeAgentProvider === detectedProvider &&
          sameAgent(current.activeAgent, detectedAgent)
        ) {
          return [null, managerState] as const;
        }
        current.activeAgentProvider = detectedProvider;
        current.activeAgent = detectedAgent;
        current.updatedAt = nextTerminalTimestamp(current.updatedAt);
        return [
          {
            type: "agentIdentity" as const,
            threadId: current.threadId,
            terminalId: current.terminalId,
            createdAt: current.updatedAt,
            runtimeGeneration: current.runtimeGeneration,
            provider: detectedProvider,
            agent: detectedAgent,
          },
          managerState,
        ] as const;
      });
      if (event) yield* ctx.publishEvent(event);
    }
  }).pipe(Effect.withSpan("terminal.pollAgentIdentity"));
}
