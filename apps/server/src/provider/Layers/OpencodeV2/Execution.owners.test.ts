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
