import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";

import type { MuseNotification } from "./Client.ts";
import { museEventBase } from "./Adapter.stream.base.ts";
import { describeMuseError } from "./Client.errors.ts";

export function mapTerminalState(terminal: string): "completed" | "failed" | "interrupted" {
  if (terminal === "completed") return "completed";
  if (terminal === "cancelled") return "interrupted";
  // Unknown terminal values are terminal-but-unrecognized, never success.
  return "failed";
}

/** Malformed terminal/error evidence is never promoted to a successful outcome. */
export function museTerminalFromParams(params: Record<string, unknown>): string {
  if (
    params.error !== undefined &&
    (!params.error ||
      typeof params.error !== "object" ||
      typeof (params.error as { message?: unknown }).message !== "string")
  )
    return "failed";
  return typeof params.terminal === "string" ? params.terminal : "failed";
}

/** Turn lifecycle mapping: started, completed/cancelled/failed, and the queued no-run exit. */
export function mapMuseTurnNotification(
  threadId: ThreadId,
  notification: MuseNotification,
): ReadonlyArray<ProviderRuntimeEvent> {
  const params = notification.params ?? {};
  if (typeof params.turnId !== "string" || !params.turnId.trim()) return [];
  switch (notification.method) {
    case "turn/started":
      return [
        {
          ...museEventBase(threadId, params.turnId as string),
          type: "turn.started",
          payload: {},
        } as ProviderRuntimeEvent,
      ];
    case "turn/completed": {
      const terminal = museTerminalFromParams(params);
      const error =
        typeof params.error === "object" && params.error !== null
          ? (params.error as { message?: unknown })
          : undefined;
      return [
        {
          ...museEventBase(threadId, params.turnId as string),
          type: "turn.completed",
          payload: {
            state: mapTerminalState(terminal),
            ...(terminal !== "completed" && terminal !== "cancelled" && terminal !== "failed"
              ? { stopReason: `unrecognized-terminal:${describeMuseError(terminal)}` }
              : {}),
            ...(typeof error?.message === "string"
              ? { errorMessage: describeMuseError(error.message) }
              : {}),
            ...(typeof params.reason === "string" && params.reason
              ? { stopReason: describeMuseError(params.reason) }
              : {}),
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "turn/unqueued":
      // No-run exit: exactly one canonical interrupted outcome for the
      // original queued submission; no turn.started is synthesized.
      return [
        {
          ...museEventBase(threadId, params.turnId as string),
          type: "turn.completed",
          payload: { state: "interrupted" },
        } as ProviderRuntimeEvent,
      ];
    default:
      return [];
  }
}
