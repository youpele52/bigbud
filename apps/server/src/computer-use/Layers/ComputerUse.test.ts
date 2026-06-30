import { ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { BrowserManager, type BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import { CuaDriver, type CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUse } from "../Services/ComputerUse.ts";
import { ComputerUseLive } from "./ComputerUse.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

describe("ComputerUseLive", () => {
  it("routes desktop-only actions to the cua driver backend", async () => {
    const browserLaunch = vi.fn(() => Effect.void);
    const callTool = vi.fn(() =>
      Effect.succeed({
        content: [{ type: "text", text: "apps" }],
        structuredContent: { apps: ["Finder"] },
      }),
    );

    const browser: BrowserManagerShape = {
      launch: browserLaunch,
      navigate: () => Effect.die("unexpected browser navigate"),
      screenshot: () => Effect.die("unexpected browser screenshot"),
      click: () => Effect.die("unexpected browser click"),
      drag: () => Effect.die("unexpected browser drag"),
      scroll: () => Effect.die("unexpected browser scroll"),
      typeText: () => Effect.die("unexpected browser type"),
      keyPress: () => Effect.die("unexpected browser key"),
      wait: () => Effect.die("unexpected browser wait"),
      getPageInfo: () => Effect.die("unexpected browser page info"),
      close: () => Effect.void,
      closeAll: () => Effect.void,
    };
    const driver: CuaDriverShape = {
      callTool,
      runDoctor: () => Effect.succeed("ok"),
      dispose: Effect.void,
    };

    const layer = ComputerUseLive.pipe(
      Layer.provide(Layer.succeed(BrowserManager, browser)),
      Layer.provide(Layer.succeed(CuaDriver, driver)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const computerUse = yield* ComputerUse;
        return yield* computerUse.execute(THREAD_ID, { action: "list_apps" });
      }).pipe(Effect.provide(layer)),
    );

    expect(browserLaunch).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith("list_apps", {});
    expect(result.action).toBe("list_apps");
  });

  it("routes browser capture actions to the browser backend", async () => {
    const callTool = vi.fn(() => Effect.die("unexpected cua driver call"));
    const browser: BrowserManagerShape = {
      launch: () => Effect.void,
      navigate: () => Effect.die("unexpected browser navigate"),
      screenshot: () =>
        Effect.succeed({
          data: Uint8Array.from([4, 5, 6]),
          mimeType: "image/png",
        }),
      click: () => Effect.die("unexpected browser click"),
      drag: () => Effect.die("unexpected browser drag"),
      scroll: () => Effect.die("unexpected browser scroll"),
      typeText: () => Effect.die("unexpected browser type"),
      keyPress: () => Effect.die("unexpected browser key"),
      wait: () => Effect.die("unexpected browser wait"),
      getPageInfo: () =>
        Effect.succeed({
          threadId: THREAD_ID,
          url: "https://example.com",
          title: "Example",
        }),
      close: () => Effect.void,
      closeAll: () => Effect.void,
    };
    const driver: CuaDriverShape = {
      callTool,
      runDoctor: () => Effect.succeed("ok"),
      dispose: Effect.void,
    };

    const layer = ComputerUseLive.pipe(
      Layer.provide(Layer.succeed(BrowserManager, browser)),
      Layer.provide(Layer.succeed(CuaDriver, driver)),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const computerUse = yield* ComputerUse;
        return yield* computerUse.execute(THREAD_ID, { action: "capture", surface: "browser" });
      }).pipe(Effect.provide(layer)),
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(result.surface).toBe("browser");
    expect(result.screenshot?.dataBase64).toBe(Buffer.from([4, 5, 6]).toString("base64"));
  });
});
