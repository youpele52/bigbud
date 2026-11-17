import { expect, it } from "vitest";
import { createMobileActivationController } from "./mobileGatewayActivation.controller.ts";
import { MobileActivationState } from "./mobileGatewayActivation.state.ts";
import type { MobileRuntimeRepairReport } from "./mobileGatewayAssets.orphan.ts";

const report: MobileRuntimeRepairReport = {
  removed: 1,
  kept: 1,
  entries: [
    { generation: `assets-${"1".repeat(32)}`, outcome: "removed", reason: "proven-orphan" },
    { generation: `assets-${"2".repeat(32)}`, outcome: "kept", reason: "pinned" },
  ],
};
const idle = async () => ({ kind: "none" }) as const;
const launch = async () => ({ kind: "unavailable" }) as const;

it("runs repair single-flight and reports its counts in status", async () => {
  let runs = 0;
  let finish!: (value: MobileRuntimeRepairReport) => void;
  const controller = createMobileActivationController(launch, "linux", idle, () => {
    runs++;
    return new Promise((resolve) => (finish = resolve));
  });
  const first = controller.repair!();
  const second = controller.repair!();
  await Promise.resolve();
  finish(report);
  expect(await first).toBe(report);
  expect(await second).toBe(report);
  expect(runs).toBe(1);
  expect(controller.status?.().lastRepair).toMatchObject({ removed: 1, kept: 1, failed: false });
});

it("records a failed repair as failed with nothing removed", async () => {
  const controller = createMobileActivationController(launch, "linux", idle, () =>
    Promise.reject(Error("journal unavailable")),
  );
  await expect(controller.repair!()).rejects.toThrow("journal unavailable");
  expect(controller.status?.().lastRepair).toMatchObject({ removed: 0, kept: 0, failed: true });
});

it("is unavailable off Linux, and retirement aborts an in-flight repair signal", async () => {
  const off = createMobileActivationController(launch, "darwin", idle, async () => report);
  await expect(off.repair!()).rejects.toThrow(/unavailable/);
  let seen: AbortSignal | undefined;
  const controller = createMobileActivationController(launch, "linux", idle, (signal) => {
    seen = signal;
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  });
  const running = controller.repair!();
  await Promise.resolve();
  await controller.close();
  expect(seen?.aborted).toBe(true);
  await expect(running).rejects.toThrow(/retiring/);
});

it("activation state runs nothing without an attached controller", async () => {
  const state = new MobileActivationState();
  expect(await state.repair()).toBeNull();
  let runs = 0;
  state.attach(
    createMobileActivationController(launch, "linux", idle, async () => (runs++, report)),
  );
  expect(await state.repair()).toBe(report);
  expect(runs).toBe(1);
});
