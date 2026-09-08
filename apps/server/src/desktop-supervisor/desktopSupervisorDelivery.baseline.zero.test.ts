import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";

function event(sequence: number): OrchestrationEvent {
  return { sequence } as OrchestrationEvent;
}

function replay(input: {
  readonly availability: "available" | "gap";
  readonly latestSequence: number;
  readonly events?: ReadonlyArray<OrchestrationEvent>;
}): OrchestrationReplayEventsResult {
  const events = input.events ?? [];
  return {
    requestedFromSequenceExclusive: 0,
    retainedFromSequenceExclusive: input.availability === "gap" ? 1 : 0,
    earliestAvailableSequence: events[0]?.sequence ?? null,
    latestSequence: input.latestSequence,
    availability: input.availability,
    complete: input.availability === "available",
    events: [...events],
  };
}

async function takeRecovery(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
) {
  for (;;) {
    const item = await subscription.take();
    if (!item) throw new Error("subscription closed before recovery");
    if (item.type === "recovery") return item;
  }
}

describe("DesktopSupervisorDelivery zero baseline admission", () => {
  it("accepts target zero when event 1 arrives during verification and replays it on the same subscription", async () => {
    const readReplay = vi
      .fn<(_cursor: number, _limit?: number) => Promise<OrchestrationReplayEventsResult>>()
      .mockResolvedValueOnce(replay({ availability: "gap", latestSequence: 0 }))
      .mockResolvedValue(
        replay({ availability: "available", latestSequence: 1, events: [event(1)] }),
      );
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const subscription = await coordinator.open({
      consumerId: "zero-baseline-valid",
      appliedSequence: 0,
      readReplay,
    });
    const recovery = await takeRecovery(subscription);

    await expect(
      coordinator.acknowledgeBaseline({
        recoveryId: recovery.recoveryId,
        consumerId: recovery.consumerId,
        consumerGeneration: recovery.consumerGeneration,
        serverEpoch: recovery.serverEpoch,
        appliedProjectionSequence: 0,
        applicationDurationMs: 1,
      }),
    ).resolves.toEqual({ accepted: true, fenced: false, acknowledgedSequence: 0 });

    for (;;) {
      const item = await subscription.take();
      if (!item) throw new Error("subscription closed before live");
      if (item.type === "lifecycle" && item.state === "live") break;
    }
    for (;;) {
      const item = await subscription.take();
      if (!item) throw new Error("subscription closed before event 1");
      if (item.type !== "batch") continue;
      expect(item.consumerGeneration).toBe(recovery.consumerGeneration);
      expect(item.events.map((entry) => entry.sequence)).toEqual([1]);
      break;
    }
    await coordinator.close();
  });

  it.each([
    ["mismatched target", replay({ availability: "gap", latestSequence: 1 }), null, undefined],
    [
      "mismatched recovery identity",
      replay({ availability: "gap", latestSequence: 0 }),
      replay({ availability: "available", latestSequence: 0 }),
      "other-recovery",
    ],
    [
      "canonical replay gap",
      replay({ availability: "gap", latestSequence: 0 }),
      replay({ availability: "gap", latestSequence: 0 }),
      undefined,
    ],
  ])(
    "rejects a %s zero baseline",
    async (_name, initialReplay, verificationReplay, recoveryIdOverride) => {
      const readReplay = vi
        .fn<(_cursor: number, _limit?: number) => Promise<OrchestrationReplayEventsResult>>()
        .mockResolvedValueOnce(initialReplay);
      if (verificationReplay) readReplay.mockResolvedValue(verificationReplay);
      const coordinator = new DesktopSupervisorDeliveryCoordinator({
        mode: "direct-unmanaged",
        reasonCode: "standalone",
      });
      const recovery = await takeRecovery(
        await coordinator.open({
          consumerId: `zero-baseline-${_name}`,
          appliedSequence: 0,
          readReplay,
        }),
      );

      await expect(
        coordinator.acknowledgeBaseline({
          recoveryId: recoveryIdOverride ?? recovery.recoveryId,
          consumerId: recovery.consumerId,
          consumerGeneration: recovery.consumerGeneration,
          serverEpoch: recovery.serverEpoch,
          appliedProjectionSequence: 0,
          applicationDurationMs: 1,
        }),
      ).resolves.toMatchObject({ accepted: false });
      await coordinator.close();
    },
  );
});
