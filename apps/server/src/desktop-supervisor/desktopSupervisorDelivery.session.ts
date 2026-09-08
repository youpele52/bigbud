import type {
  OrchestrationApplicationAckInput,
  OrchestrationApplicationAckResult,
  OrchestrationBaselineAckInput,
  OrchestrationBaselineAckResult,
  OrchestrationDeliveryLifecycle,
  OrchestrationDeliveryRecovery,
  OrchestrationDeliveryRoute,
  OrchestrationDeliveryStreamItem,
} from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import { AsyncBoundedChannel } from "./desktopSupervisorChannel.ts";
import {
  DESKTOP_SUPERVISOR_INPUT_CAPACITY,
  DESKTOP_SUPERVISOR_OUTPUT_CAPACITY,
  DESKTOP_SUPERVISOR_RESTART_ATTEMPTS,
} from "./desktopSupervisorConfig.ts";
import type { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";
import type { DesktopSupervisorOwner } from "./desktopSupervisorDelivery.ts";
import { isDesktopSupervisorIncompatibleProtocolError } from "./desktopSupervisorProtocol.ts";
import { DesktopSupervisorShadowComparator } from "./desktopSupervisorShadow.ts";
import { deliverEvent } from "./desktopSupervisorDelivery.session.batch.ts";
import { acknowledgeProjectionBaseline } from "./desktopSupervisorDelivery.session.baseline.ts";
import { requestProjectionBaseline } from "./desktopSupervisorDelivery.session.recovery.ts";
import { inspectCompleteReplay } from "./desktopSupervisorDelivery.session.replay.ts";

export type AckGate = {
  readonly batchId: string;
  readonly consumerId: string;
  readonly consumerGeneration: number;
  readonly finalSequence: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

export type BaselineGate = {
  readonly recoveryId: string;
  readonly targetSequence: number;
  readonly reasonCode: OrchestrationDeliveryRecovery["reasonCode"];
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
};

const ACKNOWLEDGED_BATCH_HISTORY_LIMIT = 256;

export class DesktopSupervisorDeliverySession {
  readonly input = new AsyncBoundedChannel<OrchestrationEvent>(DESKTOP_SUPERVISOR_INPUT_CAPACITY);
  readonly output = new AsyncBoundedChannel<OrchestrationDeliveryStreamItem>(
    DESKTOP_SUPERVISOR_OUTPUT_CAPACITY,
  );
  generation: number;
  route: OrchestrationDeliveryRoute;
  acknowledgedSequence: number;
  deliverySequence: number;
  restartAttempt = 0;
  hasAttached = false;
  closed = false;
  ackGate: AckGate | null = null;
  baselineGate: BaselineGate | null = null;
  lastBaseline: { readonly recoveryId: string; readonly sequence: number } | null = null;
  private baselineInstallation: {
    readonly recoveryId: string;
    readonly serverEpoch: string;
    readonly sequence: number;
    readonly promise: Promise<OrchestrationBaselineAckResult>;
  } | null = null;
  private readonly acknowledgedBatches = new Map<string, { received: number; applied: number }>();
  readonly pending = new Map<number, OrchestrationEvent>();
  readonly shadow: DesktopSupervisorShadowComparator;
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
      if (
        this.closed ||
        this.ackGate !== gate ||
        input.consumerGeneration !== this.generation ||
        !this.coordinator.isAuthoritative(this)
      ) {
        return { accepted: false, fenced: true, acknowledgedSequence: this.acknowledgedSequence };
      }
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

  acknowledgeBaseline(
    input: OrchestrationBaselineAckInput,
  ): Promise<OrchestrationBaselineAckResult> {
    if (
      this.closed ||
      input.consumerId !== this.consumerId ||
      input.consumerGeneration !== this.generation ||
      input.serverEpoch !== this.coordinator.serverEpoch ||
      !this.coordinator.isAuthoritative(this)
    ) {
      return Promise.resolve({
        accepted: false,
        fenced: true,
        acknowledgedSequence: this.acknowledgedSequence,
      });
    }
    const inProgress = this.baselineInstallation;
    if (inProgress) {
      if (
        inProgress.recoveryId === input.recoveryId &&
        inProgress.serverEpoch === input.serverEpoch &&
        inProgress.sequence === input.appliedProjectionSequence
      ) {
        return inProgress.promise;
      }
      return Promise.resolve({
        accepted: false,
        fenced: true,
        acknowledgedSequence: this.acknowledgedSequence,
      });
    }
    const promise = acknowledgeProjectionBaseline(this, input).finally(() => {
      if (this.baselineInstallation?.promise === promise) this.baselineInstallation = null;
    });
    this.baselineInstallation = {
      recoveryId: input.recoveryId,
      serverEpoch: input.serverEpoch,
      sequence: input.appliedProjectionSequence,
      promise,
    };
    return promise;
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

  isAttachedTo(owner: DesktopSupervisorOwner): boolean {
    return this.attachedOwner === owner && this.attachedGeneration === this.generation;
  }

  close(reason = "subscription_closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.failInFlight(new Error(`desktop delivery ${reason}`));
    const baselineGate = this.baselineGate;
    this.baselineGate = null;
    baselineGate?.reject(new Error(`desktop delivery ${reason}`));
    if (this.baselineInstallation && this.route === "supervisor") {
      void this.coordinator.fenceSupervisor(this, "baseline_subscription_closed");
    }
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
      await this.emitLifecycle("connecting");
      await this.loadReplay();
      await this.emitLifecycle("live");
    }
    while (!this.closed) {
      const event = await this.nextEvent();
      if (!event) return;
      try {
        await deliverEvent(this, event);
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
    await this.loadReplay();
    await this.emitLifecycle("live");
  }

  private async loadReplay(): Promise<void> {
    for (;;) {
      const inspection = await inspectCompleteReplay({
        acknowledgedSequence: this.acknowledgedSequence,
        readReplay: this.readReplay,
      });
      if (!inspection.recoveryReason) {
        this.installReplay(inspection.replay);
        return;
      }
      await requestProjectionBaseline(
        this,
        inspection.recoveryReason,
        inspection.replay.latestSequence,
      );
    }
  }

  private installReplay(replay: OrchestrationReplayEventsResult): void {
    for (const event of replay.events) {
      if (event.sequence > this.deliverySequence) this.pending.set(event.sequence, event);
    }
  }

  emitLifecycle(
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
