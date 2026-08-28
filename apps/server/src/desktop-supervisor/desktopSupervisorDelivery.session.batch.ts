import type { OrchestrationDeliveryBatch } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import type { DesktopSupervisorDeliverySession } from "./desktopSupervisorDelivery.session.ts";
import { DESKTOP_SUPERVISOR_APPLICATION_ACK_TIMEOUT_MS } from "./desktopSupervisorConfig.ts";
import type { DesktopSupervisorEventBatch } from "./desktopSupervisorProtocol.ts";
import { computeDesktopSupervisorBatchId } from "./desktopSupervisorProtocol.codec.ts";

const textEncoder = new TextEncoder();

export function makeProtocolBatch(
  session: DesktopSupervisorDeliverySession,
  event: OrchestrationEvent,
): DesktopSupervisorEventBatch {
  const value = {
    serverEpoch: session.coordinator.serverEpoch,
    subscriptionGeneration: session.generation,
    consumerId: session.consumerId,
    consumerGeneration: session.generation,
    events: [
      {
        eventId: event.eventId,
        sequence: event.sequence,
        canonicalPayload: textEncoder.encode(JSON.stringify(event)),
      },
    ],
  };
  return { ...value, batchId: computeDesktopSupervisorBatchId(value) };
}

export function makeDeliveryBatch(
  session: DesktopSupervisorDeliverySession,
  batch: DesktopSupervisorEventBatch,
  event: OrchestrationEvent,
): OrchestrationDeliveryBatch {
  return {
    type: "batch",
    route: session.route,
    consumerId: session.consumerId,
    consumerGeneration: session.generation,
    serverEpoch: session.coordinator.serverEpoch,
    subscriptionGeneration: session.generation,
    batchId: batch.batchId,
    events: [event],
  };
}

export async function deliverEvent(
  session: DesktopSupervisorDeliverySession,
  event: OrchestrationEvent,
): Promise<void> {
  if (event.sequence !== session.deliverySequence + 1) {
    throw new Error("desktop delivery sequence gap requires replay");
  }
  const protocolBatch = makeProtocolBatch(session, event);
  session.shadow.observeBatch(protocolBatch, session.route);
  if (session.route === "supervisor") {
    await session.coordinator.deliverSupervisor(protocolBatch);
  }
  const acknowledged = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.failInFlight(new Error("desktop delivery application acknowledgement timed out"));
    }, DESKTOP_SUPERVISOR_APPLICATION_ACK_TIMEOUT_MS);
    session.ackGate = {
      batchId: protocolBatch.batchId,
      consumerId: session.consumerId,
      consumerGeneration: session.generation,
      finalSequence: event.sequence,
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
  await session.output.offer(makeDeliveryBatch(session, protocolBatch, event));
  await acknowledged;
}
