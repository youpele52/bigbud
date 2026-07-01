import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { CuaDriverShape } from "../Services/CuaDriver.ts";
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

    expect(callTool).toHaveBeenCalledWith("list_windows", {});
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
        return Effect.succeed({ content: [{ type: "text", text: "clicked" }] });
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

    expect(callTool).toHaveBeenCalledWith("click", {
      pid: 123,
      window_id: 7,
      x: 100,
      y: 200,
      button: "left",
    });
    expect(result.desktopTarget).toEqual({
      pid: 123,
      windowId: 7,
      appName: "Notes",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    });
  });
});
