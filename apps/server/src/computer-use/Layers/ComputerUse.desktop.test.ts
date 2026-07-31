import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { CuaDriverError, type CuaDriverShape } from "../Services/CuaDriver.ts";
import { executeDesktopComputerUse } from "./ComputerUse.desktop.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

function makeDriver(overrides: Partial<CuaDriverShape> = {}): CuaDriverShape {
  return {
    callTool: () =>
      Effect.succeed({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { windows: [] },
      }),
    runDoctor: () => Effect.succeed("doctor-ok"),
    resetProxy: Effect.void,
    resetAfterUncertainAction: () => Effect.void,
    withExclusiveAccess: (effect) => effect,
    dispose: Effect.void,
    ...overrides,
  };
}

describe("executeDesktopComputerUse", () => {
  it("returns structured list_windows output", async () => {
    const callTool = vi.fn(() =>
      Effect.succeed({
        content: [{ type: "text", text: "windows" }],
        structuredContent: { windows: [{ app_name: "Finder", window_id: 42 }] },
      }),
    );
    const driver = makeDriver({ callTool });

    const result = await Effect.runPromise(
      executeDesktopComputerUse(THREAD_ID, driver, { action: "list_windows" }),
    );

    expect(callTool).toHaveBeenCalledWith(
      "list_windows",
      expect.objectContaining({ session: expect.stringMatching(/^bigbud-/) }),
    );
    expect(result.surface).toBe("desktop");
    expect(result.detailsJson).toContain("Finder");
  });

  it("runs doctor diagnostics through the driver", async () => {
    const runDoctor = vi.fn(() => Effect.succeed("platform ok"));
    const driver = makeDriver({ runDoctor });

    const result = await Effect.runPromise(
      executeDesktopComputerUse(THREAD_ID, driver, { action: "doctor" }),
    );

    expect(runDoctor).toHaveBeenCalledOnce();
    expect(result.diagnostics).toEqual({
      status: "ready",
      message: "cua-driver diagnostics completed.",
      detailsJson: "platform ok",
    });
  });

  it("requires pid or name for focus_app", async () => {
    const driver = makeDriver();

    await expect(
      Effect.runPromise(executeDesktopComputerUse(THREAD_ID, driver, { action: "focus_app" })),
    ).rejects.toThrow("requires either pid or name");
  });

  it("clicks within the frontmost desktop window", async () => {
    const callTool = vi.fn((name: string, _args: Record<string, unknown>) => {
      if (name === "list_windows") {
        return Effect.succeed({
          content: [],
          structuredContent: {
            windows: [
              {
                app_name: "Notes",
                window_id: 7,
                pid: 123,
                bounds: { x: 0, y: 0, width: 800, height: 600 },
              },
            ],
          },
        });
      }
      if (name === "click") {
        return Effect.succeed({
          content: [{ type: "text", text: "clicked" }],
          structuredContent: {
            verified: false,
            effect: "suspected_noop",
            path: "cgevent",
            escalation: { recommended: "foreground", reason: "Background input was ignored." },
          },
        });
      }
      return Effect.succeed({ content: [] });
    });
    const driver = makeDriver({ callTool });

    const result = await Effect.runPromise(
      executeDesktopComputerUse(THREAD_ID, driver, {
        action: "click",
        x: 100,
        y: 200,
      }),
    );

    expect(callTool).toHaveBeenCalledWith(
      "click",
      expect.objectContaining({
        pid: 123,
        window_id: 7,
        x: 100,
        y: 200,
        button: "left",
        session: expect.stringMatching(/^bigbud-/),
      }),
    );
    expect(result.desktopTarget).toEqual({
      pid: 123,
      windowId: 7,
      appName: "Notes",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(result.summary).toContain("may not have taken effect");
    expect(result.actionOutcome).toEqual({
      verified: false,
      effect: "suspected_noop",
      path: "cgevent",
      escalation: { recommended: "foreground", reason: "Background input was ignored." },
    });
  });

  it("selects the visible current-space window with the highest z-index", async () => {
    const callTool = vi.fn((name: string) => {
      if (name === "list_windows") {
        return Effect.succeed({
          content: [],
          structuredContent: {
            windows: [
              {
                app_name: "Hidden",
                window_id: 99,
                pid: 10,
                z_index: 100,
                is_on_screen: false,
                on_current_space: true,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
              },
              {
                app_name: "Front",
                window_id: 3,
                pid: 20,
                z_index: 8,
                is_on_screen: true,
                on_current_space: true,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
              },
              {
                app_name: "Back",
                window_id: 50,
                pid: 30,
                z_index: 2,
                is_on_screen: true,
                on_current_space: true,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
              },
            ],
          },
        });
      }
      return Effect.succeed({ content: [], structuredContent: { verified: false } });
    });

    await Effect.runPromise(
      executeDesktopComputerUse(THREAD_ID, makeDriver({ callTool }), {
        action: "click",
        x: 1,
        y: 2,
      }),
    );

    expect(callTool).toHaveBeenCalledWith(
      "click",
      expect.objectContaining({ pid: 20, window_id: 3 }),
    );
  });

  it("maps chords to hotkey and preserves action and capture details separately", async () => {
    const callTool = vi.fn((name: string) => {
      if (name === "list_windows") {
        return Effect.succeed({
          content: [],
          structuredContent: {
            windows: [
              {
                window_id: 3,
                pid: 20,
                z_index: 1,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
              },
            ],
          },
        });
      }
      if (name === "hotkey") {
        return Effect.succeed({
          content: [],
          structuredContent: { effect: "unverifiable", path: "cgevent" },
        });
      }
      if (name === "get_window_state") {
        return Effect.succeed({ content: [], structuredContent: { snapshot_id: "capture-1" } });
      }
      return Effect.succeed({ content: [] });
    });

    const result = await Effect.runPromise(
      executeDesktopComputerUse(THREAD_ID, makeDriver({ callTool }), {
        action: "key",
        key: "cmd+shift+p",
        captureAfter: true,
      }),
    );

    expect(callTool).toHaveBeenCalledWith(
      "hotkey",
      expect.objectContaining({ keys: ["cmd", "shift", "p"] }),
    );
    expect(result.actionDetailsJson).toContain('"effect": "unverifiable"');
    expect(result.captureDetailsJson).toContain('"snapshot_id": "capture-1"');
  });

  it("rejects a zero-distance scroll", async () => {
    const callTool = vi.fn((name: string) =>
      name === "list_windows"
        ? Effect.succeed({
            content: [],
            structuredContent: {
              windows: [
                {
                  window_id: 1,
                  pid: 2,
                  bounds: { x: 0, y: 0, width: 100, height: 100 },
                },
              ],
            },
          })
        : Effect.succeed({ content: [] }),
    );

    await expect(
      Effect.runPromise(
        executeDesktopComputerUse(THREAD_ID, makeDriver({ callTool }), {
          action: "scroll",
          deltaX: 0,
          deltaY: 0,
        }),
      ),
    ).rejects.toThrow("non-zero delta");
    expect(callTool).not.toHaveBeenCalledWith("scroll", expect.anything());
  });

  it("surfaces session cleanup failure and resets the proxy", async () => {
    const resetProxy = vi.fn();
    const driver = makeDriver({
      resetProxy: Effect.sync(resetProxy),
      callTool: (name) =>
        name === "end_session"
          ? Effect.fail(new CuaDriverError({ message: "cleanup failed" }))
          : Effect.succeed({ content: [], structuredContent: { apps: [] } }),
    });

    await expect(
      Effect.runPromise(executeDesktopComputerUse(THREAD_ID, driver, { action: "list_apps" })),
    ).rejects.toThrow("cleanup failed");
    expect(resetProxy).toHaveBeenCalledOnce();
  });
});
