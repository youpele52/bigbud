import type { OrchestrationDeliveryRoute } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

import type { DesktopSupervisorEventBatch } from "./desktopSupervisorProtocol.ts";
import { computeDesktopSupervisorBatchId } from "./desktopSupervisorProtocol.codec.ts";

export class DesktopSupervisorShadowComparator {
  private acknowledgedSequence: number;
  private inFlight: { readonly id: string; readonly sequence: number } | null = null;
  private fallbackFenced = false;

  constructor(appliedSequence: number) {
    this.acknowledgedSequence = appliedSequence;
  }

  observeBatch(batch: DesktopSupervisorEventBatch, route: OrchestrationDeliveryRoute): void {
    if (this.fallbackFenced && route === "supervisor") {
      throw new Error("shadow comparator detected a mid-session supervisor switchback");
    }
    const last = batch.events.at(-1);
    if (!last) {
      throw new Error("shadow comparator detected non-contiguous delivery");
    }
    if (route === "supervisor" && batch.events[0]?.sequence !== this.acknowledgedSequence + 1) {
      throw new Error("shadow comparator detected non-contiguous supervisor delivery");
    }
    const identity = {
      serverEpoch: batch.serverEpoch,
      subscriptionGeneration: batch.subscriptionGeneration,
      consumerId: batch.consumerId,
      consumerGeneration: batch.consumerGeneration,
      events: batch.events,
    };
    if (computeDesktopSupervisorBatchId(identity) !== batch.batchId) {
      throw new Error("shadow comparator detected a batch identity conflict");
    }
    this.inFlight = { id: batch.batchId, sequence: last.sequence };
  }

  observeAcknowledgement(batchId: string, sequence: number): void {
    if (this.inFlight?.id !== batchId || this.inFlight.sequence !== sequence) {
      throw new Error("shadow comparator detected an acknowledgement conflict");
    }
    this.acknowledgedSequence = sequence;
    this.inFlight = null;
  }

  observeFallbackFence(): void {
    this.fallbackFenced = true;
    this.inFlight = null;
  }
}
