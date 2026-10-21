import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { orchestrationEventListeners, rpcClientMock } from "./wsNativeApi.test.helpers";

const consumerId = "consumer-drop";

function installStorage(cursor: number) {
  const storage = new Map<string, string>([
    ["bigbud:orchestration-delivery-consumer", consumerId],
    [`bigbud:orchestration-delivery-cursor:${consumerId}`, String(cursor)],
  ]);
  const browserStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
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

const batch = {
  type: "batch" as const,
  route: "direct-unmanaged" as const,
  consumerId,
  consumerGeneration: 3,
  serverEpoch: "epoch-1",
  subscriptionGeneration: 3,
  batchId: "batch-11-12",
  events: [11, 12].map((sequence) => ({ sequence })) as never,
};

describe("wsNativeApi — socket drop mid-batch", () => {
  it("treats a refused acknowledgement as a transport drop and resumes from the cursor", async () => {
    const storage = installStorage(10);
    const { createWsNativeApi } = await import("./wsNativeApi");
    const { getOrchestrationDeliveryLifecycle } = await import("./orchestrationDeliveryState");
    // Same module instance as wsNativeApi, which the helpers reload per test.
    const { markWsSubscriptionListenerFailure, WsTransportDisconnectedError } =
      await import("./wsTransport.errors");
    orchestrationEventListeners.clear();
    const api = createWsNativeApi();
    // Like the root route: apply the batch, then acknowledge it.
    api.orchestration.onDomainEvent(async (item) => {
      if (item.type !== "batch") return;
      await api.orchestration.acknowledgeDelivery({
        batchId: item.batchId,
        consumerId: item.consumerId,
        consumerGeneration: item.consumerGeneration,
        receivedThroughSequence: 12,
        appliedThroughSequence: 12,
        applicationDurationMs: 1,
      });
    });
    const call = rpcClientMock.orchestration.onDomainEvent.mock.calls.at(-1);
    const subscriptionInput = call?.[0] as () => { consumerId: string; appliedSequence: number };
    const listener = call?.[1] as (item: OrchestrationDeliveryStreamItem) => Promise<void>;
    const options = call?.[2] as {
      retryDelay: (context: { error: unknown; attempt: number }) => number;
      shouldRetry: (error: unknown) => boolean;
    };

    // The socket dropped while the batch was applying: fail-fast refuses the acknowledgement.
    rpcClientMock.orchestration.acknowledgeDelivery.mockRejectedValue(
      new WsTransportDisconnectedError(),
    );
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const error = await listener(batch).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(WsTransportDisconnectedError);
      const marked = markWsSubscriptionListenerFailure(error);
      expect(options.shouldRetry(marked)).toBe(true);
      // No application back-off ladder: the drop is retried like any transport failure.
      expect(options.retryDelay({ error: marked, attempt })).toBe(250);
    }
    expect(getOrchestrationDeliveryLifecycle()).toBeNull();
    // Resubscription resumes from the last acknowledged sequence; nothing was skipped.
    expect(subscriptionInput()).toEqual({ consumerId, appliedSequence: 10 });
    expect(storage.get(`bigbud:orchestration-delivery-cursor:${consumerId}`)).toBe("10");

    // After reconnect the server replays 11-12 and the acknowledgement lands.
    rpcClientMock.orchestration.acknowledgeDelivery.mockResolvedValue({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 12,
    });
    await listener(batch);
    expect(subscriptionInput()).toEqual({ consumerId, appliedSequence: 12 });
    expect(storage.get(`bigbud:orchestration-delivery-cursor:${consumerId}`)).toBe("12");
  });
});
