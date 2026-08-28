import type {
  OrchestrationApplicationAckInput,
  OrchestrationApplicationAckResult,
  OrchestrationDeliveryBatch,
  OrchestrationDeliveryLifecycle,
  OrchestrationDeliveryRoute,
  OrchestrationDeliveryStreamItem,
} from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import { AsyncBoundedChannel } from "./desktopSupervisorChannel.ts";
import {
  DESKTOP_SUPERVISOR_INPUT_CAPACITY,
  DESKTOP_SUPERVISOR_APPLICATION_ACK_TIMEOUT_MS,
  DESKTOP_SUPERVISOR_OUTPUT_CAPACITY,
  DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY,
  DESKTOP_SUPERVISOR_RESTART_ATTEMPTS,
} from "./desktopSupervisorConfig.ts";
import type { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";
import type { DesktopSupervisorOwner } from "./desktopSupervisorDelivery.ts";
import {
  isDesktopSupervisorIncompatibleProtocolError,
  type DesktopSupervisorEventBatch,
} from "./desktopSupervisorProtocol.ts";
import { computeDesktopSupervisorBatchId } from "./desktopSupervisorProtocol.codec.ts";
import { DesktopSupervisorShadowComparator } from "./desktopSupervisorShadow.ts";

type AckGate = {
  readonly batchId: string;
  readonly consumerId: string;
  readonly consumerGeneration: number;
  readonly finalSequence: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

const textEncoder = new TextEncoder();
const ACKNOWLEDGED_BATCH_HISTORY_LIMIT = 256;
const REPLAY_PAGE_LIMIT = 1_000;

export class DesktopSupervisorDeliverySession {
  readonly input = new AsyncBoundedChannel<OrchestrationEvent>(DESKTOP_SUPERVISOR_INPUT_CAPACITY);
  readonly output = new AsyncBoundedChannel<OrchestrationDeliveryStreamItem>(
    DESKTOP_SUPERVISOR_OUTPUT_CAPACITY,
  );
  generation: number;
  route: OrchestrationDeliveryRoute;
  acknowledgedSequence: number;
  private deliverySequence: number;
  restartAttempt = 0;
  hasAttached = false;
  closed = false;
  private ackGate: AckGate | null = null;
  private readonly acknowledgedBatches = new Map<string, { received: number; applied: number }>();
  private readonly pending = new Map<number, OrchestrationEvent>();
  private readonly shadow: DesktopSupervisorShadowComparator;
  private attachedGeneration: number | null = null;
  private attachedOwner: DesktopSupervisorOwner | null = null;
  private consecutiveDeliveryFailures = 0;

  constructor(
    readonly coordinator: DesktopSupervisorDeliveryCoordinator,
    readonly consumerId: string,
    generation: number,
    appliedSequence: number,
    route: OrchestrationDeliveryRoute,
    readonly readReplay: (
      fromSequenceExclusive: number,
      limit?: number,
    ) => Promise<OrchestrationReplayEventsResult>,
  ) {
    this.generation = generation;
    this.acknowledgedSequence = appliedSequence;
    this.deliverySequence = appliedSequence;
    this.route = route;
    this.shadow = new DesktopSupervisorShadowComparator(appliedSequence);
  }

  start(): void {
    void this.run().catch((cause: unknown) => {
      if (!this.closed) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        void this.emitLifecycle("degraded", error.name).finally(() => this.close());
      }
    });
  }

  async acknowledge(
    input: OrchestrationApplicationAckInput,
  ): Promise<OrchestrationApplicationAckResult> {
    if (
      this.closed ||
      input.consumerId !== this.consumerId ||
      input.consumerGeneration !== this.generation ||
      input.appliedThroughSequence < this.acknowledgedSequence
    ) {
      return { accepted: false, fenced: true, acknowledgedSequence: this.acknowledgedSequence };
    }
    const gate = this.ackGate;
    if (!gate || gate.batchId !== input.batchId) {
      if (
        this.acknowledgedBatches.get(input.batchId)?.received === input.receivedThroughSequence &&
        this.acknowledgedBatches.get(input.batchId)?.applied === input.appliedThroughSequence
      ) {
        return { accepted: true, fenced: false, acknowledgedSequence: this.acknowledgedSequence };
      }
      return { accepted: false, fenced: true, acknowledgedSequence: this.acknowledgedSequence };
    }
    if (
      gate.consumerId !== input.consumerId ||
      gate.consumerGeneration !== input.consumerGeneration ||
      input.receivedThroughSequence !== gate.finalSequence ||
      input.appliedThroughSequence !== gate.finalSequence ||
      input.receivedThroughSequence < this.acknowledgedSequence
    ) {
      return { accepted: false, fenced: true, acknowledgedSequence: this.acknowledgedSequence };
    }
    try {
      const sequence =
        this.route === "supervisor"
          ? await this.coordinator.acknowledgeSupervisor(input)
          : input.appliedThroughSequence;
      if (sequence !== input.appliedThroughSequence) {
        throw new Error("desktop supervisor acknowledged an unexpected sequence");
      }
      this.acknowledgedSequence = sequence;
      this.deliverySequence = sequence;
      this.acknowledgedBatches.set(input.batchId, {
        received: input.receivedThroughSequence,
        applied: input.appliedThroughSequence,
      });
      if (this.acknowledgedBatches.size > ACKNOWLEDGED_BATCH_HISTORY_LIMIT) {
        this.acknowledgedBatches.delete(this.acknowledgedBatches.keys().next().value!);
      }
      this.shadow.observeAcknowledgement(input.batchId, sequence);
      if (this.route === "supervisor") {
        this.consecutiveDeliveryFailures = 0;
        this.restartAttempt = 0;
      }
      this.ackGate = null;
      gate.resolve();
      return { accepted: true, fenced: false, acknowledgedSequence: sequence };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.ackGate = null;
      gate.reject(error);
      throw error;
    }
  }

  failInFlight(error: Error): void {
    const gate = this.ackGate;
    if (!gate) return;
    this.ackGate = null;
    gate.reject(error);
  }

  setAttachment(owner: DesktopSupervisorOwner, generation: number): void {
    this.attachedOwner = owner;
    this.attachedGeneration = generation;
    this.hasAttached = true;
  }

  clearAttachment(): { owner: DesktopSupervisorOwner; generation: number } | null {
    const owner = this.attachedOwner;
    const generation = this.attachedGeneration;
    this.attachedOwner = null;
    this.attachedGeneration = null;
    this.hasAttached = false;
    return owner && generation !== null ? { owner, generation } : null;
  }

  close(reason = "subscription_closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.failInFlight(new Error(`desktop delivery ${reason}`));
    this.input.close();
    this.output.close();
    this.coordinator.detachSupervisor(this, reason);
    this.coordinator.remove(this);
  }

  private async run(): Promise<void> {
    if (this.route === "supervisor") {
      await this.emitLifecycle("connecting");
      await this.recoverSupervisor("initial_attach");
    } else if (this.route === "fallback-fenced") {
      await this.emitLifecycle("degraded", this.coordinator.configReasonCode);
      await this.emitLifecycle("fallback", this.coordinator.configReasonCode);
      await this.loadReplay();
    } else {
      await this.emitLifecycle("live");
      await this.loadReplay();
    }
    while (!this.closed) {
      const event = await this.nextEvent();
      if (!event) return;
      try {
        await this.deliver(event);
      } catch (cause) {
        if (this.closed) return;
        if (this.route !== "supervisor") throw cause;
        this.pending.set(event.sequence, event);
        this.consecutiveDeliveryFailures += 1;
        await this.recoverSupervisor(
          cause instanceof Error ? cause.name : "supervisor_delivery_failure",
        );
      }
    }
  }

  private async nextEvent(): Promise<OrchestrationEvent | null> {
    for (;;) {
      const nextSequence = Math.min(...this.pending.keys());
      if (Number.isFinite(nextSequence)) {
        const event = this.pending.get(nextSequence);
        this.pending.delete(nextSequence);
        if (event && event.sequence > this.deliverySequence) return event;
      }
      const event = await this.input.take();
      if (!event) return null;
      if (event.sequence > this.deliverySequence) return event;
    }
  }

  private async recoverSupervisor(reasonCode: string): Promise<void> {
    await this.emitLifecycle(this.restartAttempt === 0 ? "connecting" : "reconnecting", reasonCode);
    if (this.consecutiveDeliveryFailures >= DESKTOP_SUPERVISOR_RESTART_ATTEMPTS) {
      await this.coordinator.fenceSupervisor(this, "recovery_budget_exhausted");
      this.route = "fallback-fenced";
      this.shadow.observeFallbackFence();
      await this.emitLifecycle("degraded", reasonCode);
      await this.emitLifecycle("fallback", "recovery_budget_exhausted");
      await this.loadReplay();
      return;
    }
    let recovered: boolean;
    try {
      recovered = await this.coordinator.recover(this);
    } catch (cause) {
      if (!isDesktopSupervisorIncompatibleProtocolError(cause)) throw cause;
      await this.emitLifecycle("incompatible", "incompatible_protocol");
      this.close();
      return;
    }
    if (this.closed) return;
    if (!recovered) {
      this.route = "fallback-fenced";
      this.shadow.observeFallbackFence();
      await this.emitLifecycle("degraded", reasonCode);
      await this.emitLifecycle("fallback", "recovery_budget_exhausted");
      await this.loadReplay();
      return;
    }
    const replay = await this.readCompleteReplay();
    if (replay.availability === "gap" || !replay.complete) {
      this.route = "fallback-fenced";
      this.shadow.observeFallbackFence();
      await this.coordinator.fenceSupervisor(this, "replay_gap");
      this.replaceReplayGapWithSnapshotBaseline(replay.latestSequence);
      await this.emitLifecycle("degraded", "replay_gap");
      await this.emitLifecycle("fallback", "replay_gap");
      return;
    }
    this.installReplay(replay);
    await this.emitLifecycle("live");
  }

  private async loadReplay(): Promise<void> {
    const replay = await this.readCompleteReplay();
    if (replay.availability === "available" && replay.complete) this.installReplay(replay);
    else {
      this.replaceReplayGapWithSnapshotBaseline(replay.latestSequence);
      await this.emitLifecycle("degraded", "replay_gap");
      await this.emitLifecycle("fallback", "replay_gap");
    }
  }

  private async readCompleteReplay(): Promise<OrchestrationReplayEventsResult> {
    const events: OrchestrationEvent[] = [];
    let cursor = this.acknowledgedSequence;
    for (;;) {
      const page = await this.readReplay(cursor, REPLAY_PAGE_LIMIT);
      if (events.length + page.events.length > DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY) {
        return { ...page, complete: false, events: [] };
      }
      events.push(...page.events);
      if (page.availability === "gap" || page.complete) {
        return { ...page, events };
      }
      const nextCursor = page.events.at(-1)?.sequence;
      if (nextCursor === undefined || nextCursor <= cursor) {
        return { ...page, complete: false, events };
      }
      cursor = nextCursor;
    }
  }

  private installReplay(replay: OrchestrationReplayEventsResult): void {
    for (const event of replay.events) {
      if (event.sequence > this.deliverySequence) this.pending.set(event.sequence, event);
    }
  }

  private replaceReplayGapWithSnapshotBaseline(latestSequence: number): void {
    this.deliverySequence = Math.max(this.deliverySequence, latestSequence);
    for (const sequence of this.pending.keys()) {
      if (sequence <= this.deliverySequence) this.pending.delete(sequence);
    }
  }

  private async deliver(event: OrchestrationEvent): Promise<void> {
    if (event.sequence !== this.deliverySequence + 1) {
      throw new Error("desktop delivery sequence gap requires replay");
    }
    const protocolBatch = this.protocolBatch(event);
    this.shadow.observeBatch(protocolBatch, this.route);
    if (this.route === "supervisor") {
      await this.coordinator.deliverSupervisor(protocolBatch);
    }
    const batch = this.deliveryBatch(protocolBatch, event);
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.failInFlight(new Error("desktop delivery application acknowledgement timed out"));
      }, DESKTOP_SUPERVISOR_APPLICATION_ACK_TIMEOUT_MS);
      this.ackGate = {
        batchId: protocolBatch.batchId,
        consumerId: this.consumerId,
        consumerGeneration: this.generation,
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
    await this.output.offer(batch);
    await acknowledged;
  }

  private protocolBatch(event: OrchestrationEvent): DesktopSupervisorEventBatch {
    const value = {
      serverEpoch: this.coordinator.serverEpoch,
      subscriptionGeneration: this.generation,
      consumerId: this.consumerId,
      consumerGeneration: this.generation,
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

  private deliveryBatch(
    batch: DesktopSupervisorEventBatch,
    event: OrchestrationEvent,
  ): OrchestrationDeliveryBatch {
    return {
      type: "batch",
      route: this.route,
      consumerId: this.consumerId,
      consumerGeneration: this.generation,
      serverEpoch: this.coordinator.serverEpoch,
      subscriptionGeneration: this.generation,
      batchId: batch.batchId,
      events: [event],
    };
  }

  private emitLifecycle(
    state: OrchestrationDeliveryLifecycle["state"],
    reasonCode?: string,
  ): Promise<boolean> {
    return this.output.offer({
      type: "lifecycle",
      route: this.route,
      consumerId: this.consumerId,
      consumerGeneration: this.generation,
      state,
      acknowledgedSequence: this.acknowledgedSequence,
      restartAttempt: this.restartAttempt,
      ...(reasonCode ? { reasonCode } : {}),
    });
  }
}
