import { describe, expect, it, vi } from "vitest";

import { emitEvent, orchestrationEventListeners, rpcClientMock } from "./wsNativeApi.test.helpers";

function installStorage(consumerId: string): Map<string, string> {
  const storage = new Map<string, string>([["bigbud:orchestration-delivery-consumer", consumerId]]);
  const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  } as Storage;
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: browserStorage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: browserStorage });
  return storage;
}

describe("wsNativeApi baseline acknowledgement", () => {
  it("persists an accepted projection baseline without waiting for another event", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const consumerId = "consumer-baseline";
    const storage = installStorage(consumerId);
    rpcClientMock.orchestration.acknowledgeDeliveryBaseline.mockResolvedValue({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 4_530_348,
    });

    const api = createWsNativeApi();
    api.orchestration.onDomainEvent(vi.fn());
    emitEvent(orchestrationEventListeners, {
      type: "recovery",
      route: "direct-unmanaged",
      recoveryId: "recovery-1",
      consumerId,
      consumerGeneration: 1,
      serverEpoch: "epoch-1",
      acknowledgedSequence: 496_663,
      targetSequence: 4_530_348,
      reasonCode: "replay_budget_exceeded",
    });
    await api.orchestration.acknowledgeDeliveryBaseline({
      recoveryId: "recovery-1",
      consumerId,
      consumerGeneration: 1,
      serverEpoch: "epoch-1",
      appliedProjectionSequence: 4_530_348,
      applicationDurationMs: 10,
    });

    expect(storage.get(`bigbud:orchestration-delivery-cursor:${consumerId}`)).toBe("4530348");
  });

  it("does not persist a baseline response from a superseded stream epoch", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const consumerId = "consumer-stale-baseline";
    const storage = installStorage(consumerId);
    let resolveAck!: (value: {
      accepted: true;
      fenced: false;
      acknowledgedSequence: number;
    }) => void;
    rpcClientMock.orchestration.acknowledgeDeliveryBaseline.mockImplementation(
      () => new Promise((resolve) => (resolveAck = resolve)),
    );
    const api = createWsNativeApi();
    api.orchestration.onDomainEvent(vi.fn());
    const recovery = {
      type: "recovery" as const,
      route: "direct-unmanaged" as const,
      recoveryId: "recovery-stale",
      consumerId,
      consumerGeneration: 1,
      serverEpoch: "epoch-1",
      acknowledgedSequence: 4,
      targetSequence: 10,
      reasonCode: "replay_budget_exceeded" as const,
    };
    emitEvent(orchestrationEventListeners, recovery);
    const pending = api.orchestration.acknowledgeDeliveryBaseline({
      recoveryId: recovery.recoveryId,
      consumerId,
      consumerGeneration: 1,
      serverEpoch: recovery.serverEpoch,
      appliedProjectionSequence: 10,
      applicationDurationMs: 1,
    });
    const options = rpcClientMock.orchestration.onDomainEvent.mock.calls.at(-1)?.[2] as
      | { onResubscribe?: () => void }
      | undefined;
    options?.onResubscribe?.();
    resolveAck({ accepted: true, fenced: false, acknowledgedSequence: 10 });

    await expect(pending).resolves.toEqual({
      accepted: false,
      fenced: true,
      acknowledgedSequence: 0,
    });
    expect(storage.has(`bigbud:orchestration-delivery-cursor:${consumerId}`)).toBe(false);
  });
});
