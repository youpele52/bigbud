import { randomUUID } from "node:crypto";

import { Effect, Layer, ServiceMap } from "effect";
import type {
  OrchestrationApplicationAckInput,
  OrchestrationApplicationAckResult,
} from "@bigbud/contracts/orchestration/orchestration.delivery.ts";

import {
  DESKTOP_SUPERVISOR_HEARTBEAT_MS,
  DESKTOP_SUPERVISOR_DETACHED_GENERATION_TOMBSTONE_CAPACITY,
  DESKTOP_SUPERVISOR_ACTIVE_SESSION_LIMIT,
  DESKTOP_SUPERVISOR_RESTART_ATTEMPTS,
  DESKTOP_SUPERVISOR_RESTART_WINDOW_MS,
  desktopSupervisorRestartDelayMs,
  resolveDesktopSupervisorRuntimeConfig,
  type DesktopSupervisorRuntimeConfig,
} from "./desktopSupervisorConfig.ts";
import { DesktopSupervisorDeliverySession } from "./desktopSupervisorDelivery.session.ts";
import type {
  DesktopSupervisorDeliveryShape,
  DesktopSupervisorSubscription,
} from "./desktopSupervisorDelivery.types.ts";
import { DesktopSupervisorOwnerClient } from "./desktopSupervisorOwnerClient.ts";
import type {
  DesktopSupervisorApplicationAck,
  DesktopSupervisorEventBatch,
  DesktopSupervisorFrame,
} from "./desktopSupervisorProtocol.ts";
import { isDesktopSupervisorIncompatibleProtocolError } from "./desktopSupervisorProtocol.ts";
import { computeDesktopSupervisorBatchId } from "./desktopSupervisorProtocol.codec.ts";

export interface DesktopSupervisorOwner {
  readonly attach: DesktopSupervisorOwnerClient["attach"];
  readonly detach: DesktopSupervisorOwnerClient["detach"];
  readonly enqueue: DesktopSupervisorOwnerClient["enqueue"];
  readonly acknowledge: DesktopSupervisorOwnerClient["acknowledge"];
  readonly heartbeat: DesktopSupervisorOwnerClient["heartbeat"];
  readonly onFailure: DesktopSupervisorOwnerClient["onFailure"];
  readonly onFrame: DesktopSupervisorOwnerClient["onFrame"];
  readonly close: DesktopSupervisorOwnerClient["close"];
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export class DesktopSupervisorDeliveryCoordinator implements DesktopSupervisorDeliveryShape {
  readonly serverEpoch = randomUUID();
  readonly configReasonCode: string;
  private readonly generations = new Map<string, number>();
  private generationCounter = 0;
  private readonly sessions = new Map<string, DesktopSupervisorDeliverySession>();
  private readonly authoritativeSessions = new Map<string, DesktopSupervisorDeliverySession>();
  private client: DesktopSupervisorOwner | null = null;
  private clientPromise: Promise<DesktopSupervisorOwner> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly ownerFactory: () => Promise<DesktopSupervisorOwner>;

  constructor(
    readonly config: DesktopSupervisorRuntimeConfig,
    ownerFactory?: () => Promise<DesktopSupervisorOwner>,
    private readonly consumerIdentityCapacity = DESKTOP_SUPERVISOR_DETACHED_GENERATION_TOMBSTONE_CAPACITY,
    private readonly activeSessionLimit = DESKTOP_SUPERVISOR_ACTIVE_SESSION_LIMIT,
  ) {
    this.configReasonCode = config.mode === "supervisor" ? "configured" : config.reasonCode;
    this.ownerFactory =
      ownerFactory ??
      (() => {
        if (config.mode !== "supervisor") {
          return Promise.reject(new Error("desktop supervisor binary is not configured"));
        }
        return DesktopSupervisorOwnerClient.start({
          binaryPath: config.binaryPath,
          clientInstanceId: this.serverEpoch,
        });
      });
  }

  async open(
    input: Parameters<DesktopSupervisorDeliveryShape["open"]>[0],
  ): Promise<DesktopSupervisorSubscription> {
    if (this.closed) throw new Error("desktop supervisor delivery coordinator is closed");
    const previous = this.authoritativeSessions.get(input.consumerId);
    if (!previous && this.authoritativeSessions.size >= this.activeSessionLimit) {
      throw new Error("desktop supervisor active session limit reached");
    }
    previous?.close("subscription_superseded");
    const generation = this.allocateGeneration(input.consumerId);
    const session = new DesktopSupervisorDeliverySession(
      this,
      input.consumerId,
      generation,
      input.appliedSequence,
      this.config.mode,
      input.readReplay,
    );
    this.sessions.set(this.sessionKey(input.consumerId, generation), session);
    this.authoritativeSessions.set(input.consumerId, session);
    session.start();
    return {
      consumerId: input.consumerId,
      offer: (event) => Promise.resolve(session.input.tryOffer(event)),
      take: () => session.output.take(),
      close: () => session.close(),
    };
  }

  acknowledge(input: OrchestrationApplicationAckInput): Promise<OrchestrationApplicationAckResult> {
    const session = this.sessions.get(this.sessionKey(input.consumerId, input.consumerGeneration));
    if (session) return session.acknowledge(input);
    return Promise.resolve({
      accepted: false,
      fenced: true,
      acknowledgedSequence: 0,
    });
  }

  get retainedConsumerGenerationCount(): number {
    return this.generations.size;
  }

  async recover(session: DesktopSupervisorDeliverySession): Promise<boolean> {
    if (
      this.config.mode !== "supervisor" ||
      session.route !== "supervisor" ||
      !this.isAuthoritative(session)
    ) {
      return false;
    }
    const startedAt = Date.now();
    for (let attempt = 1; attempt <= DESKTOP_SUPERVISOR_RESTART_ATTEMPTS; attempt += 1) {
      if (this.closed || session.closed || !this.isAuthoritative(session)) return false;
      session.restartAttempt = attempt;
      if (session.hasAttached) {
        session.clearAttachment();
        this.invalidateClient(new Error("desktop supervisor generation fenced for recovery"));
        this.deleteSessionKeys(session);
        session.generation = this.allocateGeneration(session.consumerId);
        this.sessions.set(this.sessionKey(session.consumerId, session.generation), session);
      }
      try {
        const client = await this.startClient();
        if (this.closed || session.closed || !this.isAuthoritative(session)) return false;
        const generation = session.generation;
        const acknowledged = await client.attach({
          consumerId: session.consumerId,
          consumerGeneration: generation,
          serverEpoch: this.serverEpoch,
          appliedSequence: session.acknowledgedSequence,
        });
        if (acknowledged !== session.acknowledgedSequence) {
          throw new Error(
            "desktop supervisor attach cursor does not match verified application ACK",
          );
        }
        if (this.closed || session.closed || !this.isAuthoritative(session)) {
          await client
            .detach({
              consumerId: session.consumerId,
              consumerGeneration: generation,
              reason: "subscription_closed_during_attach",
            })
            .catch(() => undefined);
          return false;
        }
        session.setAttachment(client, generation);
        return true;
      } catch (cause) {
        if (this.closed || session.closed || !this.isAuthoritative(session)) return false;
        this.invalidateClient(cause);
        if (isDesktopSupervisorIncompatibleProtocolError(cause)) throw cause;
        if (
          attempt === DESKTOP_SUPERVISOR_RESTART_ATTEMPTS ||
          Date.now() - startedAt >= DESKTOP_SUPERVISOR_RESTART_WINDOW_MS
        ) {
          return false;
        }
        await delay(desktopSupervisorRestartDelayMs(attempt));
      }
    }
    return false;
  }

  async deliverSupervisor(batch: DesktopSupervisorEventBatch): Promise<void> {
    const client = await this.startClient();
    const response = await client.enqueue(batch);
    if (response.type === "recoveryRequired") {
      throw new Error(`desktop supervisor requested recovery: ${response.value.reasonCode}`);
    }
    if (response.type !== "eventBatch") {
      throw new Error(`desktop supervisor returned unexpected ${response.type}`);
    }
    const responseIdentity = {
      serverEpoch: response.value.serverEpoch,
      subscriptionGeneration: response.value.subscriptionGeneration,
      consumerId: response.value.consumerId,
      consumerGeneration: response.value.consumerGeneration,
      events: response.value.events,
    };
    const expectedId = computeDesktopSupervisorBatchId(responseIdentity);
    if (response.value.batchId !== batch.batchId || expectedId !== batch.batchId) {
      throw new Error("desktop supervisor returned a conflicting batch identity");
    }
  }

  async acknowledgeSupervisor(input: OrchestrationApplicationAckInput): Promise<number> {
    const ack: DesktopSupervisorApplicationAck = input;
    return (await this.startClient()).acknowledge(ack);
  }

  async fenceSupervisor(session: DesktopSupervisorDeliverySession, reason: string): Promise<void> {
    if (!this.isAuthoritative(session)) return;
    session.clearAttachment();
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    if (client) await client.close(`fenced_${reason}`).catch(() => undefined);
  }

  remove(session: DesktopSupervisorDeliverySession): void {
    this.deleteSessionKeys(session);
    if (this.authoritativeSessions.get(session.consumerId) === session) {
      this.authoritativeSessions.delete(session.consumerId);
    }
    if (
      this.generations.get(session.consumerId) === session.generation &&
      !this.hasLiveSession(session.consumerId)
    ) {
      this.generations.delete(session.consumerId);
      this.generations.set(session.consumerId, session.generation);
    }
  }

  private deleteSessionKeys(session: DesktopSupervisorDeliverySession): void {
    for (const [key, candidate] of this.sessions) {
      if (candidate === session) this.sessions.delete(key);
    }
  }

  detachSupervisor(session: DesktopSupervisorDeliverySession, reason: string): void {
    const attachment = session.clearAttachment();
    if (!attachment) return;
    void attachment.owner
      .detach({
        consumerId: session.consumerId,
        consumerGeneration: attachment.generation,
        reason,
      })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const session of new Set(this.sessions.values())) session.close();
    this.sessions.clear();
    this.authoritativeSessions.clear();
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    if (client) await client.close().catch(() => undefined);
  }

  private startClient(): Promise<DesktopSupervisorOwner> {
    if (this.client) return Promise.resolve(this.client);
    if (this.clientPromise) return this.clientPromise;
    if (this.config.mode !== "supervisor") {
      return Promise.reject(new Error("desktop supervisor binary is not configured"));
    }
    const started = this.ownerFactory().then((client) => {
      if (this.closed) {
        void client.close("coordinator_closed");
        throw new Error("desktop supervisor coordinator closed during startup");
      }
      this.client = client;
      this.clientPromise = null;
      client.onFailure((error) => this.invalidateClient(error, client));
      client.onFrame((frame) => this.handleUnsolicitedFrame(frame));
      this.ensureHeartbeat();
      return client;
    });
    const guarded = started.catch((cause) => {
      if (this.clientPromise === guarded) this.clientPromise = null;
      throw cause;
    });
    this.clientPromise = guarded;
    return guarded;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const startedAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const client = this.client;
      if (!client || this.closed) return;
      void client
        .heartbeat(Date.now() - startedAt)
        .catch((cause: unknown) => this.invalidateClient(cause, client));
    }, DESKTOP_SUPERVISOR_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private handleUnsolicitedFrame(frame: DesktopSupervisorFrame): boolean {
    if (frame.type !== "recoveryRequired") return false;
    const session = this.sessions.get(
      this.sessionKey(frame.value.consumerId, frame.value.consumerGeneration),
    );
    if (session?.generation === frame.value.consumerGeneration) {
      session.failInFlight(new Error(`desktop supervisor recovery: ${frame.value.reasonCode}`));
    }
    return true;
  }

  private invalidateClient(cause: unknown, expected?: DesktopSupervisorOwner): void {
    if (expected && this.client !== expected) return;
    const client = this.client;
    this.client = null;
    this.clientPromise = null;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    for (const session of new Set(this.sessions.values())) session.failInFlight(error);
    if (client) void client.close("connection_invalidated");
  }

  private allocateGeneration(consumerId: string): number {
    if (
      !this.generations.has(consumerId) &&
      this.generations.size >= this.consumerIdentityCapacity
    ) {
      let evictable: string | undefined;
      for (const candidate of this.generations.keys()) {
        if (!this.hasLiveSession(candidate)) {
          evictable = candidate;
          break;
        }
      }
      if (!evictable) throw new Error("desktop supervisor consumer identity limit reached");
      this.generations.delete(evictable);
    }
    this.generations.delete(consumerId);
    const generation = ++this.generationCounter;
    this.generations.set(consumerId, generation);
    return generation;
  }

  private hasLiveSession(consumerId: string): boolean {
    return this.authoritativeSessions.get(consumerId)?.closed === false;
  }

  private isAuthoritative(session: DesktopSupervisorDeliverySession): boolean {
    return this.authoritativeSessions.get(session.consumerId) === session && !session.closed;
  }

  private sessionKey(consumerId: string, generation: number): string {
    return `${consumerId}:${generation}`;
  }
}

export class DesktopSupervisorDelivery extends ServiceMap.Service<
  DesktopSupervisorDelivery,
  DesktopSupervisorDeliveryShape
>()("bigbud/DesktopSupervisorDelivery") {}

export const DesktopSupervisorDeliveryLive = Layer.effect(
  DesktopSupervisorDelivery,
  Effect.acquireRelease(
    Effect.sync(
      () => new DesktopSupervisorDeliveryCoordinator(resolveDesktopSupervisorRuntimeConfig()),
    ),
    (coordinator) => Effect.promise(() => coordinator.close()),
  ),
);

export const DesktopSupervisorDeliveryTestLive = Layer.succeed(
  DesktopSupervisorDelivery,
  new DesktopSupervisorDeliveryCoordinator({
    mode: "direct-unmanaged",
    reasonCode: "standalone",
  }),
);
