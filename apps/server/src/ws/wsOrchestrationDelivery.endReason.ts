import type { OrchestrationDeliverySessionEndReason } from "@bigbud/contracts/server/connectionDiagnostics.ts";
import { Cause, Exit } from "effect";

import type { DesktopSupervisorSubscription } from "../desktop-supervisor/desktopSupervisorDelivery.types.ts";

/**
 * Attributes the end of one orchestration delivery stream. A reason the
 * session recorded about itself (server shutdown, superseded, failure) wins,
 * because a closed session also makes the next live offer fail and would
 * otherwise look like an overflow. Next comes what the stream observed
 * (overflow, handoff ended) before the server began shutting down. A stream
 * closed with neither ended with the server if it was shutting down, and was
 * closed by the client otherwise.
 */
export function makeDeliveryEndReasonTracker(isServerShuttingDown: () => boolean = () => false) {
  let observed: OrchestrationDeliverySessionEndReason | null = null;
  return {
    mark(reason: OrchestrationDeliverySessionEndReason): void {
      // What a stream sees while the server tears down is a symptom of the shutdown.
      if (isServerShuttingDown()) return;
      observed ??= reason;
    },
    resolve(
      subscription: Pick<DesktopSupervisorSubscription, "endReason">,
    ): OrchestrationDeliverySessionEndReason {
      return (
        subscription.endReason?.() ??
        observed ??
        (isServerShuttingDown() ? "server-shutdown" : "client-close")
      );
    },
  };
}

/**
 * Classifies how the canonical live handoff ended. Interruption means the
 * stream's scope closed (client went away) and says nothing on its own. The
 * live capture and ordering buffers die with "... overflowed" when a slow
 * consumer falls behind; any other end means the handoff itself ended.
 */
export function classifyHandoffExit(
  exit: Exit.Exit<unknown, unknown>,
): OrchestrationDeliverySessionEndReason | null {
  if (Exit.isSuccess(exit)) return "handoff-ended";
  if (Cause.hasInterruptsOnly(exit.cause)) return null;
  const error = Cause.squash(exit.cause);
  return error instanceof Error && error.message.includes("overflowed")
    ? "overflow"
    : "handoff-ended";
}
