import type { OrchestrationCommand } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { terminalWorkAllowsIdle } from "../../terminal/Layers/Manager.idleWork.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { idleRulesFor } from "../threadOrganization.idleRules.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeListIdleThreadCandidates } from "../../persistence/Layers/ProjectionThreads.idle.ts";

/** Runs at the serialized decision boundary; never invokes process inspection. */
export const makeTerminalIdleGuard = Effect.fn("makeTerminalIdleGuard")(function* () {
  const manager = yield* Effect.serviceOption(TerminalManager);
  const settings = yield* ServerSettingsService;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  return Effect.fn("terminalIdleGuard")(function* (command: OrchestrationCommand) {
    if (command.type !== "thread.organization.idle") return false;
    if (Option.isSome(sql) && command.terminalIdleCutoff !== undefined) {
      const [candidate] = yield* makeListIdleThreadCandidates(sql.value)({
        threadId: command.threadId,
        states: [command.fromState],
        cutoff: command.terminalIdleCutoff,
        limit: 1,
      }).pipe(Effect.catchCause(() => Effect.succeed([])));
      if (!candidate || candidate.revision !== command.expectedRevision) return true;
    }
    if (Option.isNone(manager) || !manager.value.getThreadIdleWork) return false;
    // Older internal callers may omit the captured cutoff. Give them the longest applicable
    // configured wait rather than allowing completion to be treated as immediately eligible.
    const timeout = Math.max(
      0,
      ...idleRulesFor(yield* settings.getSettings)
        .filter(
          (rule) =>
            rule.enabled &&
            rule.fromStates.includes(command.fromState) &&
            rule.destination === command.destination,
        )
        .map((rule) => rule.timeoutMs),
    );
    const cutoff =
      command.terminalIdleCutoff === undefined
        ? Date.parse(command.createdAt) - timeout
        : Date.parse(command.terminalIdleCutoff);
    const work = yield* manager.value.getThreadIdleWork(command.threadId);
    return !terminalWorkAllowsIdle(work, cutoff);
  });
});
