import { ThreadId, type ComputerUseAction } from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CuaDriverError, type CuaDriverShape } from "../Services/CuaDriver.ts";
import { executeDesktopComputerUse } from "./ComputerUse.desktop.ts";
import {
  createDesktopTargets,
  type DesktopInteraction,
} from "./ComputerUse.desktop.interaction.ts";

const THREAD = ThreadId.makeUnsafe("background-thread");
const OTHER_THREAD = ThreadId.makeUnsafe("other-background-thread");
const NOTES = {
  pid: 10,
  window_id: 1,
  app_name: "Notes",
  z_index: 2,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};
const USER_WINDOW = {
  pid: 20,
  window_id: 2,
  app_name: "Browser",
  z_index: 1,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

function fixture() {
  let windows = [NOTES, USER_WINDOW];
  const interaction: DesktopInteraction = {
    deliveryMode: "background",
    targets: createDesktopTargets(),
  };
  const callTool = vi.fn((name: string, _args: Record<string, unknown>) =>
    Effect.succeed({
      content:
        name === "get_window_state"
          ? [
              { type: "image", data: "aW1n", mimeType: "image/png" },
              { type: "text", text: "window tree" },
            ]
          : [],
      structuredContent:
        name === "list_windows" || name === "launch_app"
          ? { windows }
          : name === "list_apps"
            ? { apps: [{ name: "Notes", pid: 10, running: true }] }
            : { effect: "confirmed" },
    }),
  );
  const driver: CuaDriverShape = {
    callTool,
    runDoctor: () => Effect.succeed("ok"),
    resetProxy: Effect.void,
    resetAfterUncertainAction: () => Effect.void,
    withExclusiveAccess: (effect) => effect,
    dispose: Effect.void,
  };
  return {
    callTool,
    driver,
    interaction,
    setWindows: (next: typeof windows) => {
      windows = next;
    },
    run: (action: ComputerUseAction, thread = THREAD) =>
      Effect.runPromise(executeDesktopComputerUse(thread, driver, action, undefined, interaction)),
  };
}

afterEach(() => vi.useRealTimers());

describe("background desktop interaction", () => {
  it("retains the selected window after the user focuses another app", async () => {
    const f = fixture();
    await f.run({ action: "capture", surface: "desktop" });
    f.setWindows([
      { ...NOTES, z_index: 1 },
      { ...USER_WINDOW, z_index: 3 },
    ]);
    f.callTool.mockClear();
    await f.run({ action: "click", x: 25, y: 30 });
    expect(f.callTool).toHaveBeenCalledWith(
      "click",
      expect.objectContaining({
        pid: 10,
        window_id: 1,
        delivery_mode: "background",
      }),
    );
    expect(f.callTool).toHaveBeenCalledWith(
      "start_session",
      expect.objectContaining({ capture_scope: "window" }),
    );
    const calls = f.callTool.mock.calls.map(([name]) => name);
    expect(calls.indexOf("get_window_state")).toBeLessThan(calls.indexOf("click"));
    expect(calls).not.toContain("bring_to_front");
  });

  it("selects a background app without bringing it to the front", async () => {
    const f = fixture();
    f.setWindows([
      { ...NOTES, z_index: 0 },
      { ...USER_WINDOW, z_index: 5 },
    ]);
    const result = await f.run({ action: "focus_app", pid: 10, windowId: 1 });
    expect(result.summary).toContain("without changing focus");
    expect(result.desktopTarget?.pid).toBe(10);
    expect(f.callTool).not.toHaveBeenCalledWith("bring_to_front", expect.anything());
    await f.run({ action: "type", text: "notes only" });
    expect(f.callTool).toHaveBeenCalledWith(
      "type_text",
      expect.objectContaining({ pid: 10, delivery_mode: "background" }),
    );
  });

  it("does not implicitly launch an absent focus target", async () => {
    const f = fixture();
    await expect(f.run({ action: "focus_app", name: "Missing" })).rejects.toThrow("not running");
    expect(f.callTool).not.toHaveBeenCalledWith("launch_app", expect.anything());
  });

  it("does not switch to the user's window when the selected window closes", async () => {
    const f = fixture();
    await f.run({ action: "capture" });
    f.setWindows([USER_WINDOW]);
    await expect(f.run({ action: "click", x: 1, y: 2 })).rejects.toThrow("no longer available");
    expect(f.callTool).not.toHaveBeenCalledWith("click", expect.anything());
  });

  it("rejects ambiguous target selection without retaining the old target", async () => {
    const f = fixture();
    await f.run({ action: "capture" });
    f.setWindows([NOTES, { ...NOTES, window_id: 3 }]);
    await expect(f.run({ action: "focus_app", pid: 10 })).rejects.toThrow("ambiguous");
    await expect(f.run({ action: "key", key: "Enter" })).rejects.toThrow("No background target");
    expect(f.callTool).not.toHaveBeenCalledWith("press_key", expect.anything());
  });

  it("does not open permission prompts in background mode", async () => {
    const f = fixture();
    await expect(f.run({ action: "check_permissions", prompt: true })).rejects.toThrow(
      "Permission prompts",
    );
    expect(f.callTool).not.toHaveBeenCalledWith("check_permissions", expect.anything());
  });

  it("does not share target selection between threads", async () => {
    const f = fixture();
    await f.run({ action: "capture" });
    await expect(f.run({ action: "key", key: "Enter" }, OTHER_THREAD)).rejects.toThrow(
      "No background target",
    );
    expect(f.callTool).not.toHaveBeenCalledWith("press_key", expect.anything());
  });

  it("requires a new capture after target expiry or eviction", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.run({ action: "capture" });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await expect(f.run({ action: "click", x: 1, y: 2 })).rejects.toThrow("No background target");
    expect(f.callTool).not.toHaveBeenCalledWith("click", expect.anything());
  });

  it("refuses stale coordinates after a resize", async () => {
    const f = fixture();
    await f.run({ action: "capture" });
    f.setWindows([{ ...NOTES, bounds: { ...NOTES.bounds, width: 400 } }]);
    await expect(f.run({ action: "click", x: 1, y: 2 })).rejects.toThrow("changed size");
    expect(f.callTool).not.toHaveBeenCalledWith("click", expect.anything());
  });

  it("does not send input if capture fails", async () => {
    const f = fixture();
    await f.run({ action: "capture" });
    const original = f.driver.callTool;
    const driver: CuaDriverShape = {
      ...f.driver,
      callTool: (name, args) =>
        name === "get_window_state"
          ? Effect.fail(new CuaDriverError({ message: "capture unavailable" }))
          : original(name, args),
    };
    await expect(
      Effect.runPromise(
        executeDesktopComputerUse(
          THREAD,
          driver,
          { action: "click", x: 1, y: 2 },
          undefined,
          f.interaction,
        ),
      ),
    ).rejects.toThrow("capture unavailable");
    expect(f.callTool).not.toHaveBeenCalledWith("click", expect.anything());
  });

  it("does not retry a background refusal with foreground delivery", async () => {
    const f = fixture();
    await f.run({ action: "capture" });
    const original = f.driver.callTool;
    const click = vi.fn(() =>
      Effect.fail(new CuaDriverError({ message: "background unsupported" })),
    );
    const driver: CuaDriverShape = {
      ...f.driver,
      callTool: (name, args) => (name === "click" ? click() : original(name, args)),
    };
    await expect(
      Effect.runPromise(
        executeDesktopComputerUse(
          THREAD,
          driver,
          { action: "click", x: 1, y: 2 },
          undefined,
          f.interaction,
        ),
      ),
    ).rejects.toThrow("background unsupported");
    expect(click).toHaveBeenCalledOnce();
    expect(f.callTool).not.toHaveBeenCalledWith("bring_to_front", expect.anything());
  });

  it("uses targeted window state instead of the global accessibility tree", async () => {
    const f = fixture();
    await f.run({ action: "focus_app", pid: 10, windowId: 1 });
    f.setWindows([{ ...NOTES, z_index: 0 }, USER_WINDOW]);
    const result = await f.run({ action: "get_accessibility_tree" });
    expect(result.treeText).toBe("window tree");
    expect(f.callTool).toHaveBeenCalledWith(
      "get_window_state",
      expect.objectContaining({ pid: 10, window_id: 1 }),
    );
    expect(f.callTool).not.toHaveBeenCalledWith("get_accessibility_tree", expect.anything());
  });

  it("prevents system-browser navigation from switching focus in the default mode", async () => {
    const f = fixture();
    const openBrowser = vi.fn(() => Effect.void);
    await expect(
      Effect.runPromise(
        executeDesktopComputerUse(
          THREAD,
          f.driver,
          { action: "navigate", url: "https://example.com", surface: "desktop" },
          openBrowser,
        ),
      ),
    ).rejects.toThrow("Opening the system browser");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin")(
    "binds the returned background launch window",
    async () => {
      const f = fixture();
      f.setWindows([NOTES]);
      await f.run({ action: "launch_app", name: "Notes" });
      f.setWindows([{ ...NOTES, z_index: 0 }, USER_WINDOW]);
      await f.run({ action: "key", key: "Enter" });
      expect(f.callTool).toHaveBeenCalledWith(
        "press_key",
        expect.objectContaining({ pid: 10, delivery_mode: "background" }),
      );
      expect(f.callTool).not.toHaveBeenCalledWith("bring_to_front", expect.anything());
    },
  );
});
