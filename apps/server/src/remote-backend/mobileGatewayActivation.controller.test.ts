import { describe, expect, it } from "vitest";
import {
  createMobileActivationController,
  type MobileActivationLaunch,
} from "./mobileGatewayActivation.controller.ts";
import type { NativeMobileActivationOutcome } from "./mobileGatewayActivation.launch.ts";
import { MobileActivationState } from "./mobileGatewayActivation.state.ts";
import type { NativeMobileGatewaySessionSignals } from "./mobileGatewayNative.session.ts";

const requestId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const configuration = { externalOrigin: "https://fixture.ts.net", port: 49322 };
const input = (id = requestId) => ({ requestId: id, configuration });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Scripted launch seam: the test settles each run and observes its retirement signals. */
function scriptedLaunch() {
  const events: string[] = [];
  const runs: {
    signals: NativeMobileGatewaySessionSignals;
    select: () => void;
    settle: (outcome: NativeMobileActivationOutcome) => void;
  }[] = [];
  const launch: MobileActivationLaunch = (request, signals, onSelected) =>
    new Promise((settle) => {
      events.push(`launch:${request.requestId}`);
      signals.stop.addEventListener("abort", () => events.push("stop-signal"));
      signals.detach.addEventListener("abort", () => events.push("detach-signal"));
      runs.push({ signals, select: onSelected, settle });
    });
  return { events, runs, launch };
}
async function accepted(script: ReturnType<typeof scriptedLaunch>, platform = "linux" as const) {
  const controller = createMobileActivationController(script.launch, platform);
  const acknowledged = controller.activate(input());
  await tick();
  script.runs[0]!.select();
  expect(await acknowledged).toEqual({ requestId, status: "accepted" });
  return controller;
}

describe("native mobile activation controller", () => {
  it("is unavailable off Linux without inspecting input or launching", async () => {
    const script = scriptedLaunch();
    const controller = createMobileActivationController(script.launch, "darwin");
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw Error("Input must not be inspected.");
        },
      },
    );
    expect(await controller.activate(untouchable)).toEqual({
      requestId: null,
      status: "unavailable",
    });
    expect(script.events).toEqual([]);
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it("acknowledges only after selection and refuses a second owner while one runs", async () => {
    const script = scriptedLaunch();
    const controller = createMobileActivationController(script.launch, "linux");
    let settled = false;
    const first = controller.activate(input()).finally(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    // The identical request joins the same acknowledgement; a different one is refused.
    const joined = controller.activate(input());
    await expect(controller.activate(input(otherId))).rejects.toThrow(/Another mobile gateway/);
    await expect(controller.activate({ ...input(), extra: true })).rejects.toThrow();
    script.runs[0]!.select();
    expect(await first).toEqual({ requestId, status: "accepted" });
    expect(await joined).toEqual({ requestId, status: "accepted" });
    expect(script.runs).toHaveLength(1);
  });

  it("maps pre-selection outcomes without leaving native ownership behind", async () => {
    const script = scriptedLaunch();
    const controller = createMobileActivationController(script.launch, "linux");
    const disabled = controller.activate(input());
    await tick();
    script.runs[0]!.settle({ kind: "disabled" });
    expect(await disabled).toEqual({ requestId: null, status: "disabled" });
    const failing = controller.activate(input());
    await tick();
    script.runs[1]!.settle({
      kind: "failed",
      repairRequired: false,
      cause: Error("CAS lost"),
      reason: "selection-failed",
    });
    // Nothing reached native Start: an honest `failed` with its step, never `uncertain`.
    expect(await failing).toEqual({ requestId, status: "failed", reason: "selection-failed" });
    await tick();
    expect(controller.status?.()).toMatchObject({
      phase: "idle",
      lastOutcome: { kind: "failed", repairRequired: false, reason: "selection-failed" },
    });
    await expect(controller.stop()).resolves.toBeUndefined();
    void controller.activate(input());
    await tick();
    expect(script.runs).toHaveLength(3);
  });

  it("stop waits for the recorded exit and then allows a fresh activation", async () => {
    const script = scriptedLaunch();
    const controller = await accepted(script);
    let stopped = false;
    const stopping = controller.stop().then(() => (stopped = true));
    await tick();
    expect(script.events).toEqual([`launch:${requestId}`, "stop-signal"]);
    expect(stopped).toBe(false);
    script.runs[0]!.settle({ kind: "exit-recorded" });
    await stopping;
    void controller.activate(input(otherId));
    await tick();
    expect(script.runs).toHaveLength(2);
  });

  it("a repair-required outcome stays uncertain: no relaunch and stop is not exit evidence", async () => {
    const script = scriptedLaunch();
    const controller = await accepted(script);
    const stopping = controller.stop();
    script.runs[0]!.settle({ kind: "failed", repairRequired: true, cause: Error("uncertain") });
    await expect(stopping).rejects.toThrow("uncertain");
    expect(await controller.activate(input(otherId))).toEqual({
      requestId: null,
      status: "unavailable",
    });
    await expect(controller.stop()).rejects.toThrow(/cannot be confirmed/);
    await expect(controller.close()).resolves.toBeUndefined();
    expect(script.runs).toHaveLength(1);
  });

  it("close detaches, and a detached child is never relaunched or reported stopped", async () => {
    const script = scriptedLaunch();
    const controller = await accepted(script);
    const closing = controller.close();
    await tick();
    expect(script.events).toEqual([`launch:${requestId}`, "detach-signal"]);
    script.runs[0]!.settle({ kind: "detached" });
    await expect(closing).resolves.toBeUndefined();
    expect((await controller.activate(input(otherId))).status).toBe("unavailable");
    await expect(controller.stop()).rejects.toThrow(/cannot be confirmed/);
  });

  it("close surfaces repair-required work so retirement stays uncertain", async () => {
    const script = scriptedLaunch();
    const controller = await accepted(script);
    const closing = controller.close();
    script.runs[0]!.settle({ kind: "failed", repairRequired: true, cause: Error("lost Start") });
    await expect(closing).rejects.toThrow("lost Start");
  });

  it("a launch defect after selection is treated as repair-required", async () => {
    const script = scriptedLaunch();
    let fail!: (cause: unknown) => void;
    const controller = createMobileActivationController(
      (_request, _signals, onSelected) =>
        new Promise((_resolve, reject) => {
          onSelected();
          fail = reject;
        }),
      "linux",
    );
    expect((await controller.activate(input())).status).toBe("accepted");
    fail(Error("defect"));
    await expect(controller.stop()).rejects.toThrow("defect");
    expect((await controller.activate(input(otherId))).status).toBe("unavailable");
    expect(script.runs).toHaveLength(0);
  });

  it("retirement through activation state settles a pending stop before detaching", async () => {
    const script = scriptedLaunch();
    const state = new MobileActivationState();
    const retire = state.attach(createMobileActivationController(script.launch, "linux"));
    const acknowledged = state.activate(input());
    await tick();
    await tick();
    script.runs[0]!.select();
    expect((await acknowledged).status).toBe("accepted");
    const order: string[] = [];
    const stopping = state.stop().then(() => order.push("stop-settled"));
    const retiring = retire().then(() => order.push("retired"));
    await tick();
    expect(script.events).toEqual([`launch:${requestId}`, "stop-signal"]);
    script.runs[0]!.settle({ kind: "exit-recorded" });
    await Promise.all([stopping, retiring]);
    expect(order).toEqual(["stop-settled", "retired"]);
    // The settled controller had nothing left to detach.
    expect(script.events).toEqual([`launch:${requestId}`, "stop-signal"]);
    expect((await state.activate(input())).status).toBe("unavailable");
  });

  it("reports phase and last outcome for owner status without native evidence", async () => {
    const script = scriptedLaunch();
    const controller = await accepted(script);
    expect(controller.status?.()).toEqual({
      phase: "running",
      lastOutcome: null,
      lastRepair: null,
    });
    script.runs[0]!.settle({ kind: "detached" });
    await tick();
    expect(controller.status?.()).toMatchObject({
      phase: "uncertain-detached",
      lastOutcome: { kind: "detached", repairRequired: false },
    });
    const state = new MobileActivationState();
    expect(state.status()).toEqual({
      attached: false,
      retiring: false,
      stopping: false,
      controller: null,
      inputs: null,
    });
    state.attach(controller);
    expect(state.status().controller?.phase).toBe("uncertain-detached");
  });
});
