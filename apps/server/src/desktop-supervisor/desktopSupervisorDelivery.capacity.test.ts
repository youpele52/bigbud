import { describe, expect, it } from "vitest";

import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";

const readReplay = async (fromSequenceExclusive: number) => ({
  requestedFromSequenceExclusive: fromSequenceExclusive,
  retainedFromSequenceExclusive: fromSequenceExclusive,
  earliestAvailableSequence: null,
  latestSequence: fromSequenceExclusive,
  availability: "available" as const,
  complete: true,
  events: [],
});

async function takeGeneration(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
): Promise<number> {
  for (;;) {
    const item = await subscription.take();
    if (!item) throw new Error("delivery subscription closed before a lifecycle event");
    if (item.type === "lifecycle") return item.consumerGeneration;
  }
}

describe("DesktopSupervisorDeliveryCoordinator consumer identity capacity", () => {
  it("evicts the least-recent detached identity and preserves monotonic generations", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "direct-unmanaged", reasonCode: "standalone" },
      undefined,
      2,
    );
    const first = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    expect(await takeGeneration(first)).toBe(1);
    first.close();
    const second = await coordinator.open({
      consumerId: "consumer-2",
      appliedSequence: 0,
      readReplay,
    });
    expect(await takeGeneration(second)).toBe(2);
    second.close();

    const known = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    expect(await takeGeneration(known)).toBe(3);
    known.close();
    const third = await coordinator.open({
      consumerId: "consumer-3",
      appliedSequence: 0,
      readReplay,
    });
    expect(await takeGeneration(third)).toBe(4);
    third.close();
    const evicted = await coordinator.open({
      consumerId: "consumer-2",
      appliedSequence: 0,
      readReplay,
    });
    expect(await takeGeneration(evicted)).toBe(5);
    evicted.close();
    await coordinator.close();
  });

  it("stays bounded under detached identity churn without poisoning returning owners", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "direct-unmanaged", reasonCode: "standalone" },
      undefined,
      2,
    );
    const generations: number[] = [];
    for (let index = 0; index < 128; index += 1) {
      const subscription = await coordinator.open({
        consumerId: `consumer-${index}`,
        appliedSequence: 0,
        readReplay,
      });
      const lifecycle = await subscription.take();
      if (lifecycle?.type === "lifecycle") generations.push(lifecycle.consumerGeneration);
      subscription.close();
      expect(coordinator.retainedConsumerGenerationCount).toBeLessThanOrEqual(2);
    }
    const returned = await coordinator.open({
      consumerId: "consumer-0",
      appliedSequence: 0,
      readReplay,
    });
    const returnedLifecycle = await returned.take();

    expect(generations).toHaveLength(128);
    expect(new Set(generations).size).toBe(128);
    expect(returnedLifecycle?.type).toBe("lifecycle");
    if (returnedLifecycle?.type === "lifecycle") {
      expect(returnedLifecycle.consumerGeneration).toBeGreaterThan(generations[0] ?? 0);
    }
    returned.close();
    expect(coordinator.retainedConsumerGenerationCount).toBeLessThanOrEqual(2);
    await coordinator.close();
  });

  it("never evicts a live identity to admit a new owner", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "direct-unmanaged", reasonCode: "standalone" },
      undefined,
      2,
    );
    const first = await coordinator.open({ consumerId: "live-1", appliedSequence: 0, readReplay });
    const second = await coordinator.open({
      consumerId: "live-2",
      appliedSequence: 0,
      readReplay,
    });

    await expect(
      coordinator.open({ consumerId: "blocked", appliedSequence: 0, readReplay }),
    ).rejects.toThrow("consumer identity limit reached");
    first.close();
    const admitted = await coordinator.open({
      consumerId: "admitted",
      appliedSequence: 0,
      readReplay,
    });
    admitted.close();
    second.close();
    await coordinator.close();
  });

  it("supersedes overlapping sessions that reuse one consumer identity", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "direct-unmanaged", reasonCode: "standalone" },
      undefined,
      3,
      2,
    );
    const first = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    const replacement = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    await expect(first.take()).resolves.toBeNull();
    const latest = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    await expect(replacement.take()).resolves.toBeNull();
    const distinct = await coordinator.open({
      consumerId: "consumer-2",
      appliedSequence: 0,
      readReplay,
    });
    await expect(
      coordinator.open({
        consumerId: "consumer-3",
        appliedSequence: 0,
        readReplay,
      }),
    ).rejects.toThrow("active session limit reached");
    distinct.close();
    latest.close();
    replacement.close();
    await coordinator.close();
  });
});
