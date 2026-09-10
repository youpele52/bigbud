import type {
  MobileRecoveryFrame,
  MobileRecoveryResyncReason,
} from "@bigbud/contracts/server/mobile.recovery";
import { Effect, Stream } from "effect";

import type { OrchestrationDeliveryLiveCapture } from "../orchestration/Services/OrchestrationEngine.ts";

export function makeMobileRecoveryCompletionStream(input: {
  readonly recoveryAttemptId: string;
  readonly serverEpoch: string;
  readonly liveCapture: Pick<OrchestrationDeliveryLiveCapture, "isOverflowed">;
  readonly getWatermark: () => number | null;
  readonly completeIfCurrent: Effect.Effect<boolean>;
}) {
  const resync = (reason: MobileRecoveryResyncReason): MobileRecoveryFrame => ({
    version: 1,
    type: "resync-required",
    route: "direct-unmanaged",
    recoveryAttemptId: input.recoveryAttemptId,
    serverEpoch: input.serverEpoch,
    reason,
  });

  return Stream.fromEffect(
    Effect.gen(function* () {
      const throughSequence = input.getWatermark();
      if (throughSequence === null) return resync("invalid-cursor");
      if (yield* input.liveCapture.isOverflowed) return resync("overflow");
      if (!(yield* input.completeIfCurrent)) return resync("timeout");
      return {
        version: 1 as const,
        type: "caught-up" as const,
        route: "direct-unmanaged" as const,
        recoveryAttemptId: input.recoveryAttemptId,
        serverEpoch: input.serverEpoch,
        throughSequence,
      };
    }),
  );
}
