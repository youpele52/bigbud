import { describe, expect, it } from "vitest";

import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";

const standalone = () =>
  new DesktopSupervisorDeliveryCoordinator({ mode: "direct-unmanaged", reasonCode: "standalone" });

const open = (coordinator: DesktopSupervisorDeliveryCoordinator, consumerId: string) =>
  coordinator.open({
    consumerId,
    appliedSequence: 0,
    readReplay: async () => ({ events: [], complete: true, availability: "available" }) as never,
  });

describe("delivery presence (OD6)", () => {
  it("reports an open consumer only while a delivery session is open", async () => {
    const coordinator = standalone();
    expect(coordinator.hasOpenConsumer()).toBe(false);
    const first = await open(coordinator, "consumer-1");
    const second = await open(coordinator, "consumer-2");
    expect(coordinator.hasOpenConsumer()).toBe(true);
    first.close();
    expect(coordinator.hasOpenConsumer()).toBe(true);
    second.close();
    expect(coordinator.hasOpenConsumer()).toBe(false);
    await coordinator.close();
  });

  it("reports no consumer after the coordinator closes", async () => {
    const coordinator = standalone();
    await open(coordinator, "consumer-1");
    await coordinator.close();
    expect(coordinator.hasOpenConsumer()).toBe(false);
  });
});
