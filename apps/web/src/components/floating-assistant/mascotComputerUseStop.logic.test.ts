import { ThreadId } from "@bigbud/contracts";
import type {
  ComputerUseActivitySnapshot,
  ComputerUseStopResult,
} from "@bigbud/contracts/server/computerUseActivity.ts";
import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_USE_STOPPING_FEEDBACK,
  describeComputerUseStopFailure,
  describeComputerUseStopResult,
  startMascotComputerUseStopBridge,
} from "./mascotComputerUseStop.logic";

const THREAD = ThreadId.makeUnsafe("thread-mascot-stop");
const active: ComputerUseActivitySnapshot = {
  active: true,
  turns: [
    { threadId: THREAD, turnId: null, actionInFlight: false, turnRunning: true, usedDesktop: true },
  ],
};
const inactive: ComputerUseActivitySnapshot = { active: false, turns: [] };
const stopped: ComputerUseStopResult = {
  active: true,
  interruptedThreadIds: [THREAD],
  failedThreadIds: [],
  driverReset: "reset",
  driverResetError: null,
};
const nothing: ComputerUseStopResult = {
  ...stopped,
  active: false,
  interruptedThreadIds: [],
  driverReset: "not-needed",
};

function harness(stop: () => Promise<ComputerUseStopResult>) {
  let emit!: (snapshot: ComputerUseActivitySnapshot) => void;
  let requestStop!: () => void;
  const deps = {
    subscribeActivity: vi.fn((listener: typeof emit) => {
      emit = listener;
      return vi.fn();
    }),
    stop: vi.fn(stop),
    setActive: vi.fn(async (_active: boolean) => true),
    onStopRequested: vi.fn((listener: () => void) => {
      requestStop = listener;
      return vi.fn();
    }),
    notify: vi.fn(),
  };
  const bridge = startMascotComputerUseStopBridge(deps);
  const pushed = () => deps.setActive.mock.calls.map(([value]) => value);
  return { deps, bridge, pushed, emit: (snapshot: typeof active) => emit(snapshot), requestStop };
}

describe("mascot Stop computer use bridge", () => {
  it("mirrors activity changes into the mascot menu once per change", () => {
    const { bridge, emit, pushed } = harness(async () => stopped);
    emit(inactive);
    emit(active);
    emit(active);
    emit(inactive);
    expect(pushed()).toEqual([false, true, false]);
    emit(active);
    bridge.dispose();
    expect(pushed().at(-1)).toBe(false);
  });

  it("hides the item while the server connection is down and restores it after", () => {
    const { bridge, emit, pushed } = harness(async () => stopped);
    emit(active);
    bridge.setConnected(false);
    expect(pushed()).toEqual([true, false]);
    bridge.setConnected(true);
    expect(pushed()).toEqual([true, false, true]);
  });

  it("acknowledges at once and sends every press to the server", async () => {
    const results = [stopped, nothing];
    const { deps, requestStop } = harness(async () => results.shift()!);
    requestStop();
    requestStop();
    expect(deps.notify).toHaveBeenCalledExactlyOnceWith(COMPUTER_USE_STOPPING_FEEDBACK);
    expect(deps.stop).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledTimes(2));
    // The second press found nothing left; its "already stopped" result is not repeated.
    expect(deps.notify).toHaveBeenLastCalledWith({
      severity: "success",
      title: "Computer use stopped",
      body: "Interrupt requested for 1 agent turn. The desktop driver was reset.",
    });
  });

  it("allows a new burst after the previous result arrived", async () => {
    const { deps, requestStop } = harness(async () => nothing);
    requestStop();
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledTimes(2));
    requestStop();
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledTimes(4));
    expect(deps.notify).toHaveBeenNthCalledWith(3, COMPUTER_USE_STOPPING_FEEDBACK);
  });

  it("reports a failed Stop as an error", async () => {
    const { deps, requestStop } = harness(async () => {
      throw new Error("WebSocket closed");
    });
    requestStop();
    await vi.waitFor(() =>
      expect(deps.notify).toHaveBeenLastCalledWith({
        severity: "error",
        title: "Couldn't stop computer use",
        body: "WebSocket closed",
      }),
    );
  });
});

describe("Stop feedback", () => {
  it("words each outcome by severity", () => {
    expect(
      describeComputerUseStopResult({
        ...stopped,
        failedThreadIds: [THREAD],
        driverReset: "failed",
        driverResetError: "socket busy",
      }),
    ).toMatchObject({ severity: "warning", title: "Computer use stopped with warnings" });
    expect(describeComputerUseStopResult(nothing)).toMatchObject({
      severity: "success",
      title: "Computer use already stopped",
    });
    expect(describeComputerUseStopResult({ ...stopped, driverReset: "not-needed" }).body).toBe(
      "Interrupt requested for 1 agent turn.",
    );
    expect(describeComputerUseStopResult({ ...stopped, driverReset: "unavailable" }).body).toBe(
      "Interrupt requested for 1 agent turn. No desktop driver was running.",
    );
    expect(describeComputerUseStopResult({ ...stopped, interruptedThreadIds: [] }).body).toBe(
      "No agent turn was still running. The desktop driver was reset.",
    );
    expect(describeComputerUseStopFailure("x")).toMatchObject({
      body: "The bigbud server did not respond.",
    });
  });
});
