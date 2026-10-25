import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
import { ipcMain } from "electron";
import {
  resolveLinuxDisplayServer,
  resolveTerminalRenderingPolicy,
  registerTerminalRenderingIpc,
  registerTerminalRenderingPolicy,
} from "./main.terminalRendering";

describe("terminal rendering application policy", () => {
  it.each([undefined, "disabled_software", "unavailable_software", "disabled_off"])(
    "blocks unavailable or software status %s",
    (feature) => {
      expect(resolveTerminalRenderingPolicy(false, false, feature, "linux").allowed).toBe(false);
    },
  );
  it.each(["darwin", "win32"] as const)("attempts WebGL on %s while status is unknown", (os) => {
    expect(resolveTerminalRenderingPolicy(false, false, undefined, os)).toEqual({
      allowed: true,
      reason: null,
      webglFeatureStatus: "unknown-optimistic",
    });
    for (const feature of ["disabled_software", "unavailable_software", "disabled_off"])
      expect(resolveTerminalRenderingPolicy(false, false, feature, os).allowed).toBe(false);
    expect(resolveTerminalRenderingPolicy(true, false, undefined, os).allowed).toBe(false);
    expect(resolveTerminalRenderingPolicy(false, true, undefined, os).allowed).toBe(false);
  });
  it("cannot override application disablement or crash protection", () => {
    expect(resolveTerminalRenderingPolicy(true, false, "enabled").allowed).toBe(false);
    expect(resolveTerminalRenderingPolicy(false, true, "enabled").allowed).toBe(false);
    expect(resolveTerminalRenderingPolicy(false, false, "enabled").allowed).toBe(true);
  });
  it("allows only trusted top-level policy reads, and latches actual GPU crashes", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const app = {
      on: vi.fn((event, listener) => {
        listeners.set(event, listener);
      }),
      getGPUFeatureStatus: () => ({ webgl2: "enabled" }),
    };
    registerTerminalRenderingPolicy(app as never, false, "linux");
    const mainFrame = {};
    const sender = { id: 1, mainFrame };
    registerTerminalRenderingIpc((candidate) => candidate.id === 1);
    const read = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
    expect(read({ sender, senderFrame: mainFrame } as never).allowed).toBe(false);
    listeners.get("gpu-info-update")?.();
    expect(read({ sender, senderFrame: mainFrame } as never).allowed).toBe(true);
    expect(() => read({ sender: { ...sender, id: 2 }, senderFrame: mainFrame } as never)).toThrow(
      "Untrusted",
    );
    expect(() => read({ sender, senderFrame: {} } as never)).toThrow("Untrusted");
    listeners.get("child-process-gone")?.({}, { type: "GPU", reason: "crashed" });
    expect(read({ sender, senderFrame: mainFrame } as never).allowed).toBe(false);
  });
  it.each([
    [{ webgl: "enabled" }, true, "enabled"],
    [{ webgl: "disabled_software" }, false, "disabled_software"],
    [{ webgl: "enabled", webgl2: "disabled_off" }, false, "disabled_off"],
    [{}, false, "unknown"],
  ] as const)("supports unified Chromium WebGL status %j", (features, allowed, status) => {
    const listeners = new Map<string, () => void>();
    registerTerminalRenderingPolicy(
      {
        on: (event: string, listener: () => void) => listeners.set(event, listener),
        getGPUFeatureStatus: () => features,
      } as never,
      false,
      "linux",
    );
    const mainFrame = {};
    const sender = { mainFrame };
    registerTerminalRenderingIpc(() => true);
    const read = vi.mocked(ipcMain.handle).mock.calls.at(-1)![1];
    expect(read({ sender, senderFrame: mainFrame } as never).allowed).toBe(false);
    listeners.get("gpu-info-update")?.();
    expect(read({ sender, senderFrame: mainFrame } as never)).toMatchObject({
      allowed,
      webglFeatureStatus: status,
    });
  });
  it("denies WebGL on Linux Wayland even with hardware status, and only on Linux", () => {
    expect(resolveTerminalRenderingPolicy(false, false, "enabled", "linux", "wayland")).toEqual({
      allowed: false,
      reason: expect.stringContaining("Wayland"),
      webglFeatureStatus: "linux-wayland",
    });
    expect(resolveTerminalRenderingPolicy(false, false, "enabled", "linux", "x11").allowed).toBe(
      true,
    );
    expect(
      resolveTerminalRenderingPolicy(false, false, undefined, "darwin", "wayland").allowed,
    ).toBe(true);
  });
  it("resolves the display server from the ozone override or the session", () => {
    expect(resolveLinuxDisplayServer("x11", { WAYLAND_DISPLAY: "wayland-0" })).toBe("x11");
    expect(resolveLinuxDisplayServer(null, { WAYLAND_DISPLAY: "wayland-0" })).toBe("wayland");
    expect(resolveLinuxDisplayServer(null, { XDG_SESSION_TYPE: "wayland" })).toBe("wayland");
    expect(resolveLinuxDisplayServer(null, { DISPLAY: ":0" })).toBe("x11");
  });
});
