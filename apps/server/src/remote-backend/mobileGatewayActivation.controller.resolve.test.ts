import { expect, it } from "vitest";
import { createMobileActivationController } from "./mobileGatewayActivation.controller.ts";
import type { NativeMobileSuccessorOutcome } from "./mobileGatewayNative.successor.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const neverLaunch = () => new Promise<never>(() => {});
const report = (unresolved: number) => ({
  cleared: unresolved ? 0 : 1,
  kept: unresolved,
  unresolved,
  entries: [],
});
const gc = { removed: 1, kept: 0, entries: [] };

/** A controller whose attach-time successor recovery ended uncertain (old-epoch original). */
async function uncertain(
  resolved: ReturnType<typeof report>,
  outcome: NativeMobileSuccessorOutcome = {
    kind: "failed",
    repairRequired: true,
    cause: Error("old epoch"),
    reason: "native-epoch-ended-unproven",
  },
) {
  const calls: string[] = [];
  const controller = createMobileActivationController(
    neverLaunch,
    "linux",
    async () => outcome,
    async () => (calls.push("gc"), gc),
    async () => (calls.push("resolve"), resolved),
  );
  await controller.resume().catch(() => undefined);
  await tick();
  return { controller, calls };
}

it("clears uncertainty only when no unsettled attempt remains, then runs the GC", async () => {
  const { controller, calls } = await uncertain(report(0));
  expect(controller.status?.()).toMatchObject({
    phase: "uncertain-repair",
    lastOutcome: { reason: "native-epoch-ended-unproven", repairRequired: true },
  });
  expect(await controller.resolve!()).toEqual({ ...report(0), repair: gc });
  expect(calls).toEqual(["resolve", "gc"]);
  expect(controller.status?.().phase).toBe("idle");
});

it("keeps the controller uncertain while any attempt stays unproven", async () => {
  const { controller } = await uncertain(report(1));
  expect((await controller.resolve!()).unresolved).toBe(1);
  expect(controller.status?.().phase).toBe("uncertain-repair");
  expect(
    (
      await controller.activate({
        requestId: "00000000-0000-4000-8000-000000000001",
        configuration: { externalOrigin: "https://fixture.ts.net", port: 49322 },
      })
    ).status,
  ).toBe("unavailable");
});

it("a resume whose old-epoch original was proven dead reports it retired, not uncertain", async () => {
  const { controller } = await uncertain(report(0), { kind: "exit-recorded" });
  expect(await controller.resume()).toEqual({ requestId: null, status: "retired" });
  expect(controller.status?.()).toMatchObject({
    phase: "idle",
    lastOutcome: { kind: "exit-recorded", reason: null, detail: null },
  });
});
