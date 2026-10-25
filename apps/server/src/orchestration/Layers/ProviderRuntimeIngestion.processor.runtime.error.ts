import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { normalizeRuntimeTurnState } from "./ProviderRuntimeIngestion.helpers.ts";

/** V2 turn failures have their own durable notice; readiness must not control its lifetime. */
export function runtimeSessionLastError(
  event: ProviderRuntimeEvent,
  status: string,
  previous: string | null | undefined,
): string | null {
  if (event.type === "session.state.changed" && event.payload.state === "error") {
    return event.payload.reason ?? previous ?? "Provider session error";
  }
  if (
    event.type === "turn.completed" &&
    normalizeRuntimeTurnState(event.payload.state) === "failed"
  ) {
    return event.provider === "opencodeV2"
      ? null
      : (event.payload.errorMessage ?? previous ?? "Turn failed");
  }
  return status === "ready" ? null : (previous ?? null);
}
