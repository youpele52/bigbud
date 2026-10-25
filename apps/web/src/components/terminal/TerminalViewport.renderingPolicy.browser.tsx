import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { attachTerminalRenderer } from "./TerminalViewport.rendering";

const mocks = vi.hoisted(() => ({ constructors: 0, loss: new Set<() => void>() }));
vi.mock("~/config/env", () => ({ isElectron: true }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    private listener: (() => void) | undefined;
    constructor() {
      mocks.constructors++;
    }
    activate() {}
    onContextLoss(listener: () => void) {
      this.listener = listener;
      mocks.loss.add(listener);
      return {
        dispose: () => {
          mocks.loss.delete(listener);
        },
      };
    }
    dispose() {
      if (this.listener) mocks.loss.delete(this.listener);
    }
  },
}));

it.each(["auto", "on"] as const)(
  "%s desktop retry re-reads main policy after a GPU crash",
  async (setting) => {
    let allowed = true;
    const policy = vi.fn(async () => ({
      allowed,
      reason: allowed ? null : "GPU crash protection",
      webglFeatureStatus: "enabled",
    }));
    const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { getTerminalRenderingPolicy: policy },
    });
    const mount = document.createElement("div");
    mount.style.cssText = "width:600px;height:300px";
    document.body.append(mount);
    const terminal = new Terminal();
    terminal.open(mount);
    const state = vi.fn();
    const renderer = attachTerminalRenderer(terminal, mount, state);
    try {
      renderer.update(setting);
      expect(mocks.constructors).toBe(0);
      await expect.poll(() => mocks.constructors).toBe(1);
      await expect.poll(() => state.mock.calls.at(-1)?.[0].mode).toBe("webgl");
      for (const lose of mocks.loss) lose();
      allowed = false;
      const reads = policy.mock.calls.length;
      renderer.retry();
      await expect.poll(() => policy.mock.calls.length).toBeGreaterThan(reads);
      await expect.poll(() => state.mock.calls.at(-1)?.[0].reason).toBe("GPU crash protection");
      expect(mocks.constructors).toBe(1);
      expect(state.mock.calls.at(-1)?.[0].mode).toBe("dom");
      renderer.update("off");
      expect(mocks.constructors).toBe(1);
    } finally {
      renderer.dispose();
      terminal.dispose();
      mount.remove();
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
      mocks.loss.clear();
      mocks.constructors = 0;
    }
  },
);

it("re-queries a not-yet-known desktop policy and attaches once GPU status arrives", async () => {
  let known = false;
  const policy = vi.fn(async () => ({
    allowed: known,
    reason: known ? null : "Hardware WebGL2 is unavailable or not yet known.",
    webglFeatureStatus: known ? "enabled" : "unknown",
  }));
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { getTerminalRenderingPolicy: policy },
  });
  const mount = document.createElement("div");
  mount.style.cssText = "width:600px;height:300px";
  document.body.append(mount);
  const terminal = new Terminal();
  terminal.open(mount);
  const state = vi.fn();
  const renderer = attachTerminalRenderer(terminal, mount, state);
  try {
    renderer.update("auto");
    await expect.poll(() => policy.mock.calls.length).toBeGreaterThan(0);
    expect(mocks.constructors).toBe(0);
    known = true;
    await expect.poll(() => mocks.constructors, { timeout: 3000 }).toBe(1);
    await expect.poll(() => state.mock.calls.at(-1)?.[0].mode).toBe("webgl");
  } finally {
    renderer.dispose();
    terminal.dispose();
    mount.remove();
    if (previous) Object.defineProperty(window, "desktopBridge", previous);
    else Reflect.deleteProperty(window, "desktopBridge");
    mocks.loss.clear();
    mocks.constructors = 0;
  }
});
