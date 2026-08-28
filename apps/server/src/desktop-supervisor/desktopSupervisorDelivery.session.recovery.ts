import { randomUUID } from "node:crypto";

import type { OrchestrationDeliveryRecovery } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

import type { DesktopSupervisorDeliverySession } from "./desktopSupervisorDelivery.session.ts";
import { DESKTOP_SUPERVISOR_BASELINE_ACK_TIMEOUT_MS } from "./desktopSupervisorConfig.ts";

export async function requestProjectionBaseline(
  session: DesktopSupervisorDeliverySession,
  reasonCode: OrchestrationDeliveryRecovery["reasonCode"],
  targetSequence: number,
): Promise<void> {
  const recoveryId = randomUUID();
  const acknowledged = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (session.baselineGate?.recoveryId === recoveryId) session.baselineGate = null;
      reject(new Error("desktop delivery projection baseline acknowledgement timed out"));
    }, DESKTOP_SUPERVISOR_BASELINE_ACK_TIMEOUT_MS);
    session.baselineGate = {
      recoveryId,
      targetSequence,
      reasonCode,
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
  });
  void acknowledged.catch(() => undefined);
  await session.emitLifecycle("reconnecting", reasonCode);
  await session.output.offer({
    type: "recovery",
    route: session.route,
    recoveryId,
    consumerId: session.consumerId,
    consumerGeneration: session.generation,
    serverEpoch: session.coordinator.serverEpoch,
    acknowledgedSequence: session.acknowledgedSequence,
    targetSequence,
    reasonCode,
  });
  await acknowledged;
}
