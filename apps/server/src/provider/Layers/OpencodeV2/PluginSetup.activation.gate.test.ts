import { expect, it } from "vitest";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import { deferred } from "./Test.fixtures.ts";

it("setup wait has no reservation; synchronous close/reserve races never admit stale/delayed second Locations", () => {
  const gate = new V2ActivationGate("scope", "A", () => {});
  const a = gate.verify("/A", "A", "instance-A"),
    b = gate.verify("/B", "A", "instance-B");
  expect(gate.tryCloseGate("setup-first")).toBe(true);
  expect(gate.tryReserve(a, "startup")).toBeUndefined();
  gate.beforePublication("setup-first", "N");
  gate.releaseGate("setup-first");
  const next = gate.verify("/A", "N", "new-instance-A");
  expect(gate.tryReserve(b, "delayed-B")).toBeUndefined();
  expect(() => gate.verify("/B", "A", "old-instance-B")).toThrow("expected activation");
  expect(gate.tryReserve(next, "start-A")).toBeDefined();
  expect(gate.tryCloseGate("upgrade")).toBe(false);
});

it("HTTP acknowledgement, wrapper timeout and missing durable/native proof never release physical execution ownership", async () => {
  const gate = new V2ActivationGate("scope", "A", () => {});
  const token = gate.tryReserve(gate.verify("/A", "A", "instance"), "turn")!;
  const physical = deferred<void>();
  let observedBusy = 0;
  const pending = gate.dispatch(token, () => {
    observedBusy = gate.busyCount();
    return physical.promise;
  });
  expect(observedBusy).toBe(1);
  expect(() =>
    gate.settle(token, {
      physical: true,
      durable: true,
      nativeDrained: true,
      callbacksSettled: true,
    }),
  ).toThrow("settlement unproved");
  physical.resolve();
  await pending;
  gate.nativeRunning(token);
  expect(gate.tryCloseGate("upgrade")).toBe(false);
  expect(() =>
    gate.settle(token, {
      physical: true,
      durable: true,
      nativeDrained: false,
      callbacksSettled: true,
    }),
  ).toThrow();
  gate.settle(token, {
    physical: true,
    durable: true,
    nativeDrained: true,
    callbacksSettled: true,
  });
  expect(gate.tryCloseGate("upgrade")).toBe(true);
});

it("the hard gate budget stops new publication without resurrecting stale epoch proof", () => {
  let now = 0;
  const gate = new V2ActivationGate(
    "scope",
    "A",
    () => {},
    () => now,
  );
  const prior = gate.verify("/B", "A", "instance");
  gate.tryCloseGate("job");
  gate.beforePublication("job", "N");
  now = 15000;
  expect(() => gate.beforePublication("job", "another")).toThrow("expired");
  gate.releaseGate("job");
  expect(gate.tryReserve(prior, "old-B")).toBeUndefined();
});
