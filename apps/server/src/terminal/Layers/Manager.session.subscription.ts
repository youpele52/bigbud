import { type TerminalEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { toSessionKey } from "./Manager.shell";
import type { SessionApiContext } from "./Manager.session.types.ts";
import type { TerminalSubscribeOptions } from "../Services/Manager";

/** Output stays only for sessions whose agent detection runs in the client (non-local targets). */
function scopeOutput(
  getSession: SessionApiContext["getSession"],
  listener: (event: TerminalEvent) => Effect.Effect<void>,
): (event: TerminalEvent) => Effect.Effect<void> {
  return (event) =>
    event.type !== "output"
      ? listener(event)
      : getSession(event.threadId, event.terminalId).pipe(
          Effect.flatMap((session) =>
            Option.isSome(session) && !isLocalExecutionTarget(session.value.executionTargetId)
              ? listener(event)
              : Effect.void,
          ),
        );
}

export function subscribeToTerminalEvents(
  ctx: Pick<SessionApiContext, "modifyManagerState" | "terminalEventListeners" | "getSession">,
  deliver: (event: TerminalEvent) => Effect.Effect<void>,
  options?: TerminalSubscribeOptions,
): Effect.Effect<() => void> {
  const listener =
    options?.outputScope === "legacyDetection" ? scopeOutput(ctx.getSession, deliver) : deliver;
  return Effect.gen(function* () {
    const pending: TerminalEvent[] = [];
    let initializing = true;
    const bufferedListener = (event: TerminalEvent) =>
      initializing
        ? Effect.sync(() => {
            pending.push(event);
          })
        : listener(event);

    const replay = yield* ctx.modifyManagerState((state) => {
      ctx.terminalEventListeners.add(bufferedListener);
      const events: TerminalEvent[] = [];
      const updatedAtByKey = new Map<string, string>();
      for (const session of state.sessions.values()) {
        if (!isLocalExecutionTarget(session.executionTargetId)) {
          continue;
        }
        events.push({
          type: "agentIdentity",
          threadId: session.threadId,
          terminalId: session.terminalId,
          createdAt: session.updatedAt,
          runtimeGeneration: session.runtimeGeneration,
          provider: session.activeAgentProvider,
          agent: session.activeAgent ?? null,
        });
        updatedAtByKey.set(toSessionKey(session.threadId, session.terminalId), session.updatedAt);
      }
      return [{ events, updatedAtByKey }, state] as const;
    });

    for (const event of replay.events) {
      yield* listener(event);
    }
    while (pending.length > 0) {
      const events = pending.splice(0, pending.length);
      for (const event of events) {
        const replayUpdatedAt = replay.updatedAtByKey.get(
          toSessionKey(event.threadId, event.terminalId),
        );
        if (
          event.type === "agentIdentity" &&
          replayUpdatedAt !== undefined &&
          event.createdAt <= replayUpdatedAt
        ) {
          continue;
        }
        yield* listener(event);
      }
    }
    initializing = false;
    return () => {
      ctx.terminalEventListeners.delete(bufferedListener);
    };
  });
}
