import { type TerminalEvent } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { toSessionKey } from "./Manager.shell";
import { terminalInventoryEntry } from "./Manager.hostInventory.ts";
import type { SessionApiContext } from "./Manager.session.types.ts";
import type { TerminalSubscribeOptions } from "../Services/Manager";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

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

/** Host-owned panes in the inventory and refreshes when host facts change (plan S3). */
export interface TerminalHostInventorySource {
  /** The host roster's first load (bounded by the caller). */
  readonly ready: Effect.Effect<void>;
  readonly sessions: (
    sessions: Iterable<TerminalSessionState>,
  ) => TerminalSessionInventory["sessions"][number][];
  readonly register: (
    listener: (inventory: TerminalSessionInventory) => Effect.Effect<void>,
  ) => () => void;
}

/** A first inventory waits this long at most for the host roster after a backend restart. */
const HOST_ROSTER_WAIT_MS = 3_000;

export function subscribeToTerminalEvents(
  ctx: Pick<SessionApiContext, "modifyManagerState" | "terminalEventListeners" | "getSession"> & {
    readonly hostInventory?: TerminalHostInventorySource | undefined;
  },
  deliver: (event: TerminalEvent) => Effect.Effect<void>,
  options?: TerminalSubscribeOptions,
): Effect.Effect<() => void> {
  const listener =
    options?.outputScope === "legacyDetection" ? scopeOutput(ctx.getSession, deliver) : deliver;
  return Effect.gen(function* () {
    const hostInventory = options?.onInventory ? ctx.hostInventory : undefined;
    if (hostInventory)
      yield* hostInventory.ready.pipe(
        Effect.timeoutOrElse({
          duration: HOST_ROSTER_WAIT_MS,
          orElse: () => Effect.void,
        }),
      );
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
        if (options?.outputScope === "legacyDetection") {
          // A global subscriber may have missed lifecycle/activity while reconnecting.
          if (!isWslTerminalTargetId(session.executionTargetId) || session.status !== "running") {
            events.push({
              type: "activity",
              threadId: session.threadId,
              terminalId: session.terminalId,
              createdAt: session.updatedAt,
              hasRunningSubprocess: session.status === "running" && session.hasRunningSubprocess,
            });
          }
          if (session.status === "exited" || session.status === "error") {
            const base = {
              threadId: session.threadId,
              terminalId: session.terminalId,
              createdAt: session.updatedAt,
              runtimeGeneration: session.runtimeGeneration,
            };
            events.push(
              session.status === "exited"
                ? {
                    ...base,
                    type: "exited",
                    exitCode: session.exitCode,
                    exitSignal: session.exitSignal,
                  }
                : {
                    ...base,
                    type: "error",
                    message: "Terminal is unavailable. Reconnect to inspect its status.",
                  },
            );
            updatedAtByKey.set(
              toSessionKey(session.threadId, session.terminalId),
              session.updatedAt,
            );
            continue;
          }
        }
        if (isWslTerminalTargetId(session.executionTargetId)) continue;
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
      const inventory = options?.onInventory
        ? {
            type: "inventory" as const,
            createdAt: new Date().toISOString(),
            sessions: hostInventory
              ? hostInventory.sessions(state.sessions.values())
              : [...state.sessions.values()].map(terminalInventoryEntry),
          }
        : undefined;
      return [{ events, updatedAtByKey, inventory }, state] as const;
    });

    if (options?.onInventory && replay.inventory) yield* options.onInventory(replay.inventory);
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
    const unregisterInventory =
      hostInventory && options?.onInventory
        ? hostInventory.register(options.onInventory)
        : undefined;
    return () => {
      ctx.terminalEventListeners.delete(bufferedListener);
      unregisterInventory?.();
    };
  });
}
