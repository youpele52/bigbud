import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import {
  DesktopSupervisorDeliveryCoordinator,
  type DesktopSupervisorOwner,
} from "./desktopSupervisorDelivery.ts";

function owner(): DesktopSupervisorOwner {
  return {
    attach: vi.fn(async (input) => input.appliedSequence),
    detach: vi.fn(async () => undefined),
    enqueue: vi.fn(async (batch) => ({ type: "eventBatch" as const, value: batch })),
    acknowledge: vi.fn(async (ack) => ack.appliedThroughSequence),
    installBaseline: vi.fn(async (baseline) => baseline.appliedProjectionSequence),
    heartbeat: vi.fn(async (monotonicMillis) => ({
      type: "heartbeat" as const,
      value: { monotonicMillis },
    })),
    onFailure: vi.fn(() => () => undefined),
    onFrame: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("DesktopSupervisorDelivery projection baseline", () => {
  it("fences Rust when a supervised baseline install is superseded", async () => {
    let releaseInstallation: (() => void) | undefined;
    const installationGate = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    const rust = owner();
    vi.mocked(rust.installBaseline).mockImplementation(async (baseline) => {
      await installationGate;
      return baseline.appliedProjectionSequence;
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust,
    );
    const latestSequence = 10_000;
    const readReplay = async (fromSequenceExclusive: number, limit = 1_000) => {
      const events = Array.from(
        { length: Math.min(limit, latestSequence - fromSequenceExclusive) },
        (_, index) => ({ sequence: fromSequenceExclusive + index + 1 }),
      ) as OrchestrationEvent[];
      return {
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence,
        availability: "available" as const,
        complete:
          fromSequenceExclusive >= latestSequence || events.at(-1)?.sequence === latestSequence,
        events,
      };
    };
    const subscription = await coordinator.open({
      consumerId: "consumer-supervised-superseded",
      appliedSequence: 0,
      readReplay,
    });
    let recovery: Extract<Awaited<ReturnType<typeof subscription.take>>, { type: "recovery" }>;
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "recovery") {
        recovery = item;
        break;
      }
    }
    const acknowledgement = coordinator.acknowledgeBaseline({
      recoveryId: recovery!.recoveryId,
      consumerId: recovery!.consumerId,
      consumerGeneration: recovery!.consumerGeneration,
      serverEpoch: recovery!.serverEpoch,
      appliedProjectionSequence: latestSequence,
      applicationDurationMs: 5,
    });
    await vi.waitFor(() => expect(rust.installBaseline).toHaveBeenCalledOnce());
    await coordinator.open({
      consumerId: "consumer-supervised-superseded",
      appliedSequence: 0,
      readReplay,
    });
    await vi.waitFor(() =>
      expect(rust.close).toHaveBeenCalledWith("fenced_baseline_subscription_closed"),
    );
    releaseInstallation?.();

    await expect(acknowledgement).resolves.toEqual({
      accepted: false,
      fenced: true,
      acknowledgedSequence: 0,
    });
    await coordinator.close();
  });

  it("fences baseline verification after the subscription is superseded", async () => {
    let releaseVerification: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const readReplay = async (fromSequenceExclusive: number, limit = 1_000) => {
      if (limit === 0) await verificationGate;
      const latestSequence = 10_000;
      const events = Array.from(
        { length: Math.min(limit, latestSequence - fromSequenceExclusive) },
        (_, index) => ({ sequence: fromSequenceExclusive + index + 1 }),
      ) as OrchestrationEvent[];
      return {
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence,
        availability: "available" as const,
        complete:
          fromSequenceExclusive >= latestSequence || events.at(-1)?.sequence === latestSequence,
        events,
      };
    };
    const subscription = await coordinator.open({
      consumerId: "consumer-superseded-baseline",
      appliedSequence: 0,
      readReplay,
    });
    let recovery: Extract<Awaited<ReturnType<typeof subscription.take>>, { type: "recovery" }>;
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "recovery") {
        recovery = item;
        break;
      }
    }
    const acknowledgement = coordinator.acknowledgeBaseline({
      recoveryId: recovery!.recoveryId,
      consumerId: recovery!.consumerId,
      consumerGeneration: recovery!.consumerGeneration,
      serverEpoch: recovery!.serverEpoch,
      appliedProjectionSequence: 10_000,
      applicationDurationMs: 5,
    });
    await coordinator.open({
      consumerId: "consumer-superseded-baseline",
      appliedSequence: 0,
      readReplay,
    });
    releaseVerification?.();

    await expect(acknowledgement).resolves.toEqual({
      accepted: false,
      fenced: true,
      acknowledgedSequence: 0,
    });
    await coordinator.close();
  });

  it("serializes concurrent baseline ACKs and fences a conflicting sequence", async () => {
    let releaseVerification: (() => void) | undefined;
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const latestSequence = 10_000;
    const subscription = await coordinator.open({
      consumerId: "consumer-concurrent-baseline",
      appliedSequence: 0,
      readReplay: async (fromSequenceExclusive, limit = 1_000) => {
        if (limit === 0) await verificationGate;
        const events = Array.from(
          { length: Math.min(limit, latestSequence - fromSequenceExclusive) },
          (_, index) => ({ sequence: fromSequenceExclusive + index + 1 }),
        ) as OrchestrationEvent[];
        return {
          requestedFromSequenceExclusive: fromSequenceExclusive,
          retainedFromSequenceExclusive: 0,
          earliestAvailableSequence: 1,
          latestSequence,
          availability: "available" as const,
          complete:
            fromSequenceExclusive >= latestSequence || events.at(-1)?.sequence === latestSequence,
          events,
        };
      },
    });
    let recovery: Extract<Awaited<ReturnType<typeof subscription.take>>, { type: "recovery" }>;
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "recovery") {
        recovery = item;
        break;
      }
    }
    const first = coordinator.acknowledgeBaseline({
      recoveryId: recovery!.recoveryId,
      consumerId: recovery!.consumerId,
      consumerGeneration: recovery!.consumerGeneration,
      serverEpoch: recovery!.serverEpoch,
      appliedProjectionSequence: latestSequence,
      applicationDurationMs: 5,
    });
    await vi.waitFor(() => expect(releaseVerification).toBeTypeOf("function"));
    await expect(
      coordinator.acknowledgeBaseline({
        recoveryId: recovery!.recoveryId,
        consumerId: recovery!.consumerId,
        consumerGeneration: recovery!.consumerGeneration,
        serverEpoch: recovery!.serverEpoch,
        appliedProjectionSequence: latestSequence - 1,
        applicationDurationMs: 5,
      }),
    ).resolves.toEqual({ accepted: false, fenced: true, acknowledgedSequence: 0 });
    releaseVerification?.();
    await expect(first).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: latestSequence,
    });
    await coordinator.close();
  });

  it("keeps TypeScript authoritative while Rust installs the approved sequence", async () => {
    const rust = owner();
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust,
    );
    const latestSequence = 10_000;
    const subscription = await coordinator.open({
      consumerId: "consumer-supervised-baseline",
      appliedSequence: 0,
      readReplay: async (fromSequenceExclusive, limit = 1_000) => {
        const events = Array.from(
          { length: Math.min(limit, latestSequence - fromSequenceExclusive) },
          (_, index) => ({ sequence: fromSequenceExclusive + index + 1 }),
        ) as OrchestrationEvent[];
        return {
          requestedFromSequenceExclusive: fromSequenceExclusive,
          retainedFromSequenceExclusive: 0,
          earliestAvailableSequence: 1,
          latestSequence,
          availability: "available" as const,
          complete:
            fromSequenceExclusive >= latestSequence || events.at(-1)?.sequence === latestSequence,
          events,
        };
      },
    });

    let recovery: Extract<Awaited<ReturnType<typeof subscription.take>>, { type: "recovery" }>;
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "recovery") {
        recovery = item;
        break;
      }
    }
    const input = {
      recoveryId: recovery!.recoveryId,
      consumerId: recovery!.consumerId,
      consumerGeneration: recovery!.consumerGeneration,
      serverEpoch: recovery!.serverEpoch,
      appliedProjectionSequence: latestSequence,
      applicationDurationMs: 5,
    };
    const accepted = await coordinator.acknowledgeBaseline(input);

    expect(accepted).toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: latestSequence,
    });
    expect(rust.installBaseline).toHaveBeenCalledWith(input);
    await expect(coordinator.acknowledgeBaseline(input)).resolves.toEqual(accepted);
    expect(rust.installBaseline).toHaveBeenCalledOnce();
    await coordinator.close();
  });
});
