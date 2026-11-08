import * as Effect from "effect/Effect";
import type { ProcessLifecycleContext } from "./Manager.process-lifecycle.ts";
import { toSessionKey } from "./Manager.shell.ts";
import { terminalPaneWork } from "./Manager.idleWork.ts";

export function makeInactiveSessionEviction(
  modify: ProcessLifecycleContext["modifyManagerState"],
  limit: number,
) {
  return Effect.fn("terminal.evictInactiveSessionsIfNeeded")(function* () {
    yield* modify((state) => {
      // Starting/uncertain sessions still own a process or a lifecycle reservation.
      const inactive = [...state.sessions.values()].filter(
        (session) =>
          !session.process && session.status !== "running" && terminalPaneWork(session) === "idle",
      );
      if (inactive.length <= limit) return [undefined, state] as const;
      inactive.sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.threadId.localeCompare(right.threadId) ||
          left.terminalId.localeCompare(right.terminalId),
      );
      const sessions = new Map(state.sessions);
      for (const session of inactive.slice(0, inactive.length - limit)) {
        sessions.delete(toSessionKey(session.threadId, session.terminalId));
      }
      return [undefined, { ...state, sessions }] as const;
    });
  });
}
