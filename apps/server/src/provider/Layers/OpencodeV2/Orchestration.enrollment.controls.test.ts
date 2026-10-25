import { expect, it, vi } from "vitest";
import { V2EnrollmentControls } from "./Orchestration.enrollment.controls.ts";
import { deferred } from "./Test.fixtures.ts";

it("timing out/cancelling the join leaves the actual SDK promise busy until it physically settles", async () => {
  const controls = new V2EnrollmentControls(),
    physical = deferred<void>(),
    caller = new AbortController();
  controls.observe(physical.promise);
  expect(controls.count()).toBe(1);
  const pending = controls.join(caller.signal);
  const rejected = expect(pending).rejects.toThrow("physical control remains owned");
  caller.abort();
  await rejected;
  expect(controls.count()).toBe(1);
  physical.resolve();
  await physical.promise;
  expect(controls.count()).toBe(0);
  await controls.join(new AbortController().signal);
});

it("joining physical controls also waits for the logical record mutation without aborting either", async () => {
  const controls = new V2EnrollmentControls(),
    physical = deferred<void>(),
    logical = deferred<void>(),
    signal = new AbortController(),
    completed = vi.fn();
  controls.observe(physical.promise);
  const joined = controls.join(signal.signal, logical.promise).then(completed);
  physical.resolve();
  await physical.promise;
  expect(controls.count()).toBe(0);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(signal.signal.aborted).toBe(false);
  logical.resolve();
  await joined;
  expect(completed).toHaveBeenCalledTimes(1);
});

it("control capacity remains occupied after join cancellation; only actual settlement permits another operation", async () => {
  const controls = new V2EnrollmentControls(),
    operations = Array.from({ length: 32 }, () => deferred<void>()),
    caller = new AbortController();
  for (const operation of operations) {
    controls.assertCapacity();
    controls.observe(operation.promise);
  }
  expect(controls.count()).toBe(32);
  expect(() => controls.assertCapacity()).toThrow("capacity reached; evidence retained");
  const joined = controls.join(caller.signal),
    rejected = expect(joined).rejects.toThrow("physical control remains owned");
  caller.abort();
  await rejected;
  expect(controls.count()).toBe(32);
  expect(() => controls.assertCapacity()).toThrow("capacity reached; evidence retained");
  operations[0]!.resolve();
  await operations[0]!.promise;
  expect(controls.count()).toBe(31);
  expect(() => controls.assertCapacity()).not.toThrow();
  for (const operation of operations) operation.resolve();
  await controls.join(new AbortController().signal);
  expect(controls.count()).toBe(0);
});
