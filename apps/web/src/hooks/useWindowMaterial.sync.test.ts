import { describe, expect, it, vi } from "vitest";
import type { DesktopWindowMaterialState } from "@bigbud/contracts/server/ipc.windowMaterial.ts";
import { syncWindowMaterial } from "./useWindowMaterial.sync";

function createBridge() {
  let listener: ((state: DesktopWindowMaterialState) => void) | undefined;
  let requestId: string | undefined;
  const unsubscribe = vi.fn();
  return {
    setWindowMaterial: vi.fn((_mode: string, nextRequestId?: string) => {
      requestId = nextRequestId;
      return Promise.resolve();
    }),
    getWindowMaterialState: vi.fn(
      async (): Promise<DesktopWindowMaterialState> => ({
        mode: "automatic",
        material: "solid",
        ...(requestId ? { requestId } : {}),
      }),
    ),
    onWindowMaterialState: vi.fn((next: (state: DesktopWindowMaterialState) => void) => {
      listener = next;
      return unsubscribe;
    }),
    emit: (state: DesktopWindowMaterialState) =>
      listener?.({
        ...(requestId ? { requestId } : {}),
        ...state,
      }),
    requestId: () => requestId!,
    unsubscribe,
  };
}

describe("window material synchronization", () => {
  it("subscribes before applying the saved mode and recovers its snapshot on reload", async () => {
    const bridge = createBridge();
    const onState = vi.fn();
    const stop = syncWindowMaterial(bridge, "automatic", onState);
    expect(bridge.onWindowMaterialState.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.setWindowMaterial.mock.invocationCallOrder[0]!,
    );
    await vi.waitFor(() =>
      expect(onState).toHaveBeenCalledWith({
        mode: "automatic",
        material: "solid",
        requestId: bridge.requestId(),
      }),
    );
    expect(bridge.setWindowMaterial).toHaveBeenCalledWith("automatic", bridge.requestId());
    stop();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps a live update when an older initial snapshot arrives late", async () => {
    const bridge = createBridge();
    let resolve!: (state: DesktopWindowMaterialState) => void;
    bridge.getWindowMaterialState.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onState = vi.fn();
    const stop = syncWindowMaterial(bridge, "automatic", onState);
    await vi.waitFor(() => expect(bridge.getWindowMaterialState).toHaveBeenCalledOnce());
    bridge.emit({ mode: "automatic", material: "solid" });
    resolve({ mode: "automatic", material: "translucent", requestId: bridge.requestId() });
    await Promise.resolve();
    expect(onState.mock.calls).toEqual([
      [{ mode: "automatic", material: "solid", requestId: bridge.requestId() }],
    ]);
    bridge.emit({ mode: "automatic", material: "translucent" });
    expect(onState).toHaveBeenLastCalledWith({
      mode: "automatic",
      material: "translucent",
      requestId: bridge.requestId(),
    });
    stop();
  });

  it("ignores replies and queued events after cleanup or a mode change", async () => {
    const bridge = createBridge();
    const onState = vi.fn();
    const stop = syncWindowMaterial(bridge, "solid", onState);
    bridge.emit({ mode: "automatic", material: "translucent" });
    await vi.waitFor(() => expect(bridge.getWindowMaterialState).toHaveBeenCalledOnce());
    expect(onState).not.toHaveBeenCalled();
    stop();
    bridge.emit({ mode: "solid", material: "solid" });
    expect(onState).not.toHaveBeenCalled();
  });

  it("ignores events and snapshots from an earlier selection of the same mode", async () => {
    const bridge = createBridge();
    bridge.getWindowMaterialState.mockResolvedValue({
      mode: "automatic",
      material: "translucent",
      requestId: "previous-selection",
    });
    const onState = vi.fn();
    const stop = syncWindowMaterial(bridge, "automatic", onState);
    bridge.emit({ mode: "automatic", material: "translucent", requestId: "previous-selection" });
    await vi.waitFor(() => expect(bridge.getWindowMaterialState).toHaveBeenCalledOnce());
    expect(onState).not.toHaveBeenCalled();
    bridge.emit({ mode: "automatic", material: "solid" });
    expect(onState).toHaveBeenCalledOnce();
    stop();
  });

  it("does not update after an unmount with a pending snapshot", async () => {
    const bridge = createBridge();
    let resolve!: (state: DesktopWindowMaterialState) => void;
    bridge.getWindowMaterialState.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onState = vi.fn();
    const stop = syncWindowMaterial(bridge, "automatic", onState);
    await vi.waitFor(() => expect(bridge.getWindowMaterialState).toHaveBeenCalledOnce());
    stop();
    resolve({ mode: "automatic", material: "translucent" });
    await Promise.resolve();
    expect(onState).not.toHaveBeenCalled();
  });

  it("does not request a snapshot after cleanup while applying the preference", async () => {
    const bridge = createBridge();
    let resolve!: () => void;
    bridge.setWindowMaterial.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const onState = vi.fn();
    const stop = syncWindowMaterial(bridge, "automatic", onState);
    stop();
    resolve();
    await Promise.resolve();
    expect(bridge.getWindowMaterialState).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();
  });

  it("handles unavailable bridges and failed requests without inventing a material", async () => {
    const onState = vi.fn();
    const rejected = createBridge();
    rejected.setWindowMaterial.mockRejectedValue(new Error("disconnected"));
    const stopRejected = syncWindowMaterial(rejected, "automatic", onState);
    const stopLegacy = syncWindowMaterial(
      { setWindowMaterial: vi.fn().mockResolvedValue(undefined) },
      "automatic",
      onState,
    );
    await vi.waitFor(() => expect(rejected.setWindowMaterial).toHaveBeenCalledOnce());
    expect(onState).not.toHaveBeenCalled();
    expect(rejected.getWindowMaterialState).not.toHaveBeenCalled();
    stopRejected();
    stopLegacy();
  });
});
