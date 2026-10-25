import { expect, it } from "vitest";
import { V2ActiveExecutions } from "./Execution.owners.ts";

it("revokes blocked approval work without waiting for publication and prohibits its later physical dispatch", async () => {
  const owners = new V2ActiveExecutions(),
    controller = new AbortController();
  let release!: () => void;
  const publication = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatched = false;
  const operation = owners.run(controller, async () => {
    await publication;
    return owners.dispatch(controller, async () => {
      dispatched = true;
    });
  });
  const rejected = expect(operation).rejects.toThrow();
  await owners.cancel();
  expect(controller.signal.aborted).toBe(true);
  release();
  await rejected;
  expect(dispatched).toBe(false);
});

it("joins already dispatched execution settlement and caps retained exact-owner work", async () => {
  const owners = new V2ActiveExecutions(),
    controller = new AbortController();
  let release!: () => void;
  const physical = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = owners.run(controller, () => owners.dispatch(controller, () => physical));
  await Promise.resolve();
  let cancelled = false;
  const cancellation = owners.cancel().then(() => {
    cancelled = true;
  });
  await Promise.resolve();
  expect(cancelled).toBe(false);
  release();
  await cancellation;
  await operation;
  let settle!: () => void;
  const pending = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const retained = Array.from({ length: 32 }, () =>
    owners.run(new AbortController(), () => pending),
  );
  await expect(owners.run(new AbortController(), async () => {})).rejects.toThrow("capacity");
  await owners.cancel();
  settle();
  await Promise.all(retained);
});

it("H1: a dispatched-then-failed execution stays uncertain after join until reconciled with proof", async () => {
  const owners = new V2ActiveExecutions(),
    controller = new AbortController();
  const failed = owners.run(controller, () =>
    owners.dispatch(
      controller,
      async () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
      "receipt-key",
    ),
  );
  await expect(failed).rejects.toThrow(RangeError);
  await owners.join();
  expect(owners.busyCount()).toBe(1);
  expect(owners.uncertainEntries()).toEqual([
    expect.objectContaining({ controller, receiptKey: "receipt-key" }),
  ]);
  // Without native drain, or with drain but neither durable receipt nor interrupt acknowledgement, stay held.
  const proofless = [
    { nativeDrained: false, receiptDurable: true, interruptAcknowledged: true },
    { nativeDrained: true, receiptDurable: false, interruptAcknowledged: false },
  ];
  for (const evidence of proofless) expect(owners.reconcile(controller, evidence)).toBe(false);
  expect(owners.busyCount()).toBe(1);
  const proof = { nativeDrained: true, receiptDurable: true, interruptAcknowledged: false };
  expect(owners.reconcile(new AbortController(), proof)).toBe(false);
  expect(owners.reconcile(controller, proof)).toBe(true);
  expect(owners.busyCount()).toBe(0);
  expect(owners.uncertainEntries()).toEqual([]);
});

it("an undispatched failure never becomes uncertain and reconcile cannot clear active work", async () => {
  const owners = new V2ActiveExecutions(),
    controller = new AbortController();
  await expect(
    owners.run(controller, async () => {
      throw new Error("pre-dispatch refusal");
    }),
  ).rejects.toThrow("pre-dispatch refusal");
  expect(owners.busyCount()).toBe(0);
  let release!: () => void;
  const physical = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = owners.run(controller, () => owners.dispatch(controller, () => physical));
  await Promise.resolve();
  const proof = { nativeDrained: true, receiptDurable: true, interruptAcknowledged: true };
  expect(owners.reconcile(controller, proof)).toBe(false);
  expect(owners.busyCount()).toBe(1);
  release();
  await running;
  expect(owners.busyCount()).toBe(0);
});
