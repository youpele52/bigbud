import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopWindowMaterial } from "@bigbud/contracts/core/settings.ts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import type { DesktopWindowMaterialState } from "@bigbud/contracts/server/ipc.windowMaterial.ts";

vi.mock("../../config/env", () => ({ isElectron: true }));
vi.mock("../../lib/utils", () => ({ isMacPlatform: () => true }));
vi.mock("../../hooks/useSettings", () => ({ useSettings: () => ({ windowMaterial: mode }) }));

import { useWindowMaterial } from "../../hooks/useWindowMaterial";

let mode: DesktopWindowMaterial = "automatic";
let root: Root;
let mount: HTMLDivElement;
let listener: ((state: DesktopWindowMaterialState) => void) | undefined;
let rerender: (() => void) | undefined;
let requestId: string | undefined;
const originalBridge = window.desktopBridge;
const setMaterial = vi.fn();
const unsubscribe = vi.fn();

function emit(state: DesktopWindowMaterialState) {
  listener?.({ ...(requestId ? { requestId } : {}), ...state });
}

function Harness() {
  const [, update] = useState(0);
  rerender = () => update((value) => value + 1);
  useWindowMaterial();
  return null;
}

describe("window material in the renderer", () => {
  beforeEach(() => {
    mode = "automatic";
    listener = undefined;
    unsubscribe.mockClear();
    setMaterial.mockReset().mockImplementation((_mode: string, nextRequestId: string) => {
      requestId = nextRequestId;
      return Promise.resolve();
    });
    window.desktopBridge = {
      setWindowMaterial: setMaterial,
      getWindowMaterialState: async () => null,
      onWindowMaterialState: (next: (state: DesktopWindowMaterialState) => void) => {
        listener = next;
        return unsubscribe;
      },
    } as unknown as DesktopBridge;
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    root.unmount();
    mount.remove();
    if (originalBridge) window.desktopBridge = originalBridge;
    else delete window.desktopBridge;
    delete document.documentElement.dataset.desktopShell;
    delete document.documentElement.dataset.windowMaterial;
    delete document.documentElement.dataset.windowMaterialMode;
  });

  it("starts solid, follows native changes, and keeps the saved mode Automatic", async () => {
    flushSync(() => root.render(<Harness />));
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
    await vi.waitFor(() =>
      expect(setMaterial).toHaveBeenCalledWith("automatic", expect.any(String)),
    );
    flushSync(() => emit({ mode: "automatic", material: "translucent" }));
    expect(document.documentElement.dataset.windowMaterial).toBe("translucent");
    flushSync(() => emit({ mode: "automatic", material: "solid" }));
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
    expect(document.documentElement.dataset.windowMaterialMode).toBe("automatic");
    expect(setMaterial).toHaveBeenCalledTimes(1);
  });

  it("waits for confirmation when the user changes modes and cleans up subscriptions", async () => {
    flushSync(() => root.render(<Harness />));
    await vi.waitFor(() => expect(listener).toBeDefined());
    flushSync(() => emit({ mode: "automatic", material: "translucent" }));
    mode = "solid";
    flushSync(() => rerender?.());
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
    await vi.waitFor(() => expect(setMaterial).toHaveBeenCalledWith("solid", expect.any(String)));
    expect(unsubscribe).toHaveBeenCalledOnce();
    flushSync(() => emit({ mode: "automatic", material: "translucent" }));
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
    flushSync(() => emit({ mode: "solid", material: "solid" }));
    expect(document.documentElement.dataset.windowMaterialMode).toBe("solid");
  });

  it("requires fresh confirmation when a preference is selected again", async () => {
    flushSync(() => root.render(<Harness />));
    await vi.waitFor(() => expect(listener).toBeDefined());
    flushSync(() => emit({ mode: "automatic", material: "translucent" }));
    const previousRequestId = requestId!;
    mode = "solid";
    flushSync(() => rerender?.());
    await vi.waitFor(() => expect(setMaterial).toHaveBeenCalledWith("solid", expect.any(String)));
    mode = "automatic";
    flushSync(() => rerender?.());
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
    flushSync(() =>
      emit({ mode: "automatic", material: "translucent", requestId: previousRequestId }),
    );
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
    flushSync(() => emit({ mode: "automatic", material: "solid" }));
    expect(document.documentElement.dataset.windowMaterial).toBe("solid");
  });
});
