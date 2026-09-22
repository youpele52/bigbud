import type { OrchestrationDeliveryBatch } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import type { DesktopSupervisorDeliverySession } from "./desktopSupervisorDelivery.session.ts";
import { DESKTOP_SUPERVISOR_APPLICATION_ACK_TIMEOUT_MS } from "./desktopSupervisorConfig.ts";
import type { DesktopSupervisorEventBatch } from "./desktopSupervisorProtocol.ts";
import { computeDesktopSupervisorBatchId } from "./desktopSupervisorProtocol.codec.ts";

const textEncoder = new TextEncoder();

export function makeProtocolBatch(
  session: DesktopSupervisorDeliverySession,
  events: ReadonlyArray<OrchestrationEvent>,
): DesktopSupervisorEventBatch {
  const value = {
    serverEpoch: session.coordinator.serverEpoch,
    subscriptionGeneration: session.generation,
    consumerId: session.consumerId,
    consumerGeneration: session.generation,
    events: events.map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      canonicalPayload: textEncoder.encode(JSON.stringify(event)),
    })),
  };
  return { ...value, batchId: computeDesktopSupervisorBatchId(value) };
}

export function makeDeliveryBatch(
  session: DesktopSupervisorDeliverySession,
  batch: DesktopSupervisorEventBatch,
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationDeliveryBatch {
  return {
    type: "batch",
    route: session.route,
    consumerId: session.consumerId,
    consumerGeneration: session.generation,
    serverEpoch: session.coordinator.serverEpoch,
    subscriptionGeneration: session.generation,
    batchId: batch.batchId,
    events: [...events],
  };
}

export async function deliverBatch(
  session: DesktopSupervisorDeliverySession,
  events: ReadonlyArray<OrchestrationEvent>,
): Promise<void> {
  const first = events[0];
  const final = events.at(-1);
  if (!first || !final) {
    throw new Error("desktop delivery batch must contain at least one event");
  }
  if (first.sequence !== session.deliverySequence + 1) {
    throw new Error("desktop delivery sequence gap requires replay");
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence !== events[index - 1]!.sequence + 1) {
      throw new Error("desktop delivery batch must be contiguous");
    }
  }
  const protocolBatch = makeProtocolBatch(session, events);
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
      finalSequence: final.sequence,
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
  await session.output.offer(makeDeliveryBatch(session, protocolBatch, events));
  await acknowledged;
}
