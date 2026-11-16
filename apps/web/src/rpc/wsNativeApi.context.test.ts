import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import { rpcClientMock } from "./wsNativeApi.test.helpers";
import type { WsRpcClient } from "./wsRpcClient.types";

function owner(consumerId: string) {
  let input: (() => { consumerId: string; appliedSequence: number }) | undefined;
  let event: ((item: OrchestrationDeliveryStreamItem) => unknown) | undefined;
  const unsubscribe = vi.fn();
  const dispose = vi.fn(async () => {});
  const acknowledgeDelivery = vi.fn(async () => ({
    accepted: true,
    fenced: false,
    acknowledgedSequence: 7,
  }));
  const rpc = {
    ...rpcClientMock,
    dispose,
    orchestration: {
      ...rpcClientMock.orchestration,
      acknowledgeDelivery,
      onDomainEvent: vi.fn((getInput, listener) => {
        input = getInput;
        event = listener;
        return unsubscribe;
      }),
    },
  } as WsRpcClient;
  const write = vi.fn();
  return {
    rpc,
    dispose,
    unsubscribe,
    acknowledgeDelivery,
    write,
    cursor: { consumerId, read: () => (consumerId === "a" ? 2 : 5), write },
    getInput: () => input?.(),
    emit: (item: OrchestrationDeliveryStreamItem) => event?.(item),
  };
}
const recovery: OrchestrationDeliveryStreamItem = {
  type: "recovery",
  route: "direct-unmanaged",
  recoveryId: "recovery-a",
  consumerId: "a",
  consumerGeneration: 1,
  serverEpoch: "epoch",
  acknowledgedSequence: 2,
  targetSequence: 7,
  reasonCode: "replay_unavailable",
};

describe("explicit native API owners", () => {
  it("keeps simultaneous clients' subscriptions and cursor acknowledgements separate", async () => {
    const { createWsNativeApiContext } = await import("./wsNativeApi");
    const a = owner("a");
    const b = owner("b");
    const first = createWsNativeApiContext({ rpcClient: a.rpc, deliveryCursor: a.cursor });
    const second = createWsNativeApiContext({ rpcClient: b.rpc, deliveryCursor: b.cursor });
    const onA = vi.fn();
    const onB = vi.fn();
    first.api.orchestration.onDomainEvent(onA);
    second.api.orchestration.onDomainEvent(onB);
    expect(a.getInput()).toEqual({ consumerId: "a", appliedSequence: 2 });
    expect(b.getInput()).toEqual({ consumerId: "b", appliedSequence: 5 });
    await a.emit(recovery);
    expect(onA).toHaveBeenCalledOnce();
    expect(onB).not.toHaveBeenCalled();
    await first.api.orchestration.acknowledgeDelivery({
      consumerId: "a",
      consumerGeneration: 1,
      batchId: "batch-a",
      receivedThroughSequence: 7,
      appliedThroughSequence: 7,
      applicationDurationMs: 1,
    });
    expect(a.write).toHaveBeenCalledWith(7);
    expect(b.write).not.toHaveBeenCalled();
    await first.dispose();
    await first.dispose();
    expect(a.unsubscribe).toHaveBeenCalledOnce();
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.unsubscribe).not.toHaveBeenCalled();
    expect(b.dispose).not.toHaveBeenCalled();
    await a.emit(recovery);
    expect(onA).toHaveBeenCalledOnce();
    expect(() => first.api.orchestration.onDomainEvent(onA)).toThrow("disposed");
    await second.dispose();
  });

  it("fences acknowledgements resolving after disposal without persisting into either owner", async () => {
    const { createWsNativeApiContext } = await import("./wsNativeApi");
    const a = owner("a");
    let settle!: (value: {
      accepted: boolean;
      fenced: boolean;
      acknowledgedSequence: number;
    }) => void;
    a.acknowledgeDelivery.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const context = createWsNativeApiContext({ rpcClient: a.rpc, deliveryCursor: a.cursor });
    const pending = context.api.orchestration.acknowledgeDelivery({
      consumerId: "a",
      consumerGeneration: 1,
      batchId: "batch-a",
      receivedThroughSequence: 7,
      appliedThroughSequence: 7,
      applicationDurationMs: 1,
    });
    await context.dispose();
    settle({ accepted: true, fenced: false, acknowledgedSequence: 7 });
    expect(await pending).toMatchObject({ accepted: false, fenced: true });
    expect(a.write).not.toHaveBeenCalled();
    await expect(
      context.api.orchestration.acknowledgeDelivery({
        consumerId: "a",
        consumerGeneration: 1,
        batchId: "batch-a",
        receivedThroughSequence: 7,
        appliedThroughSequence: 7,
        applicationDurationMs: 1,
      }),
    ).rejects.toThrow("disposed");
    expect(a.acknowledgeDelivery).toHaveBeenCalledOnce();
  });
});
