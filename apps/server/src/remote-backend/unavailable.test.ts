import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadId, TurnId } from "@bigbud/contracts";

import { ComputerUse } from "../computer-use/Services/ComputerUse.ts";
import { CuaDriver } from "../computer-use/Services/CuaDriver.ts";
import { BrowserManager } from "../browser/Services/BrowserManager.ts";
import {
  VisibleBrowserControl,
  getVisibleBrowserControl,
} from "../browser/Services/VisibleBrowserControl.ts";
import { Open } from "../utils/open.ts";
import { MobileRemoteControl } from "../mobile/Services/MobileRemoteControl.ts";
import { AnalyticsService } from "../telemetry/Services/AnalyticsService.ts";
import {
  RemoteComputerUseLive,
  RemoteOpenLive,
  RemoteVisibleBrowserControlLive,
} from "./unavailable.host.ts";
import { RemoteAnalyticsLive, RemoteMobileControlLive } from "./unavailable.services.ts";

describe("remote profile unavailable facilities", () => {
  it("returns typed failures for host actions and reports no acquired browser or driver resources", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const open = yield* Open;
        const computer = yield* ComputerUse;
        const browser = yield* BrowserManager;
        const driver = yield* CuaDriver;
        expect((yield* open.openBrowser("https://example.invalid").pipe(Effect.flip))._tag).toBe(
          "OpenError",
        );
        expect(
          (yield* computer
            .execute(ThreadId.makeUnsafe("fixture"), { action: "doctor" })
            .pipe(Effect.flip))._tag,
        ).toBe("ComputerUseError");
        expect((yield* browser.launch(ThreadId.makeUnsafe("fixture")).pipe(Effect.flip))._tag).toBe(
          "BrowserManagerError",
        );
        expect((yield* driver.callTool("anything", {}).pipe(Effect.flip))._tag).toBe(
          "CuaDriverError",
        );
        expect(yield* computer.isActive!(ThreadId.makeUnsafe("fixture"))).toBe(false);
        expect(yield* driver.stopAllActivity!("fixture")).toBe("idle");
      }).pipe(Effect.provide(Layer.mergeAll(RemoteComputerUseLive, RemoteOpenLive))),
    );
  });

  it("installs a scoped unavailable visible-browser control and clears it on shutdown", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* VisibleBrowserControl;
          expect(getVisibleBrowserControl()).toBe(control);
          expect(yield* control.isAvailable).toBe(false);
          expect(yield* control.resolveThreadLease(ThreadId.makeUnsafe("fixture"))).toBeUndefined();
          const error = yield* control
            .execute({
              threadId: ThreadId.makeUnsafe("fixture"),
              turnId: TurnId.makeUnsafe("fixture"),
              action: { action: "get_page_info" },
            })
            .pipe(Effect.flip);
          expect(error._tag).toBe("VisibleBrowserControlError");
          expect(yield* Stream.runCollect(control.streamCommands("fixture"))).toEqual([]);
        }).pipe(Effect.provide(RemoteVisibleBrowserControlLive)),
      ),
    );
    expect(getVisibleBrowserControl()).toBeNull();
  });

  it("denies mobile tokens and pairing without persistence or analytics activity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const mobile = yield* MobileRemoteControl;
        const analytics = yield* AnalyticsService;
        expect(yield* mobile.validateSessionToken("any-token")).toBeNull();
        expect(yield* mobile.listSessions).toEqual([]);
        expect(yield* mobile.getPairingStatus("any-pairing")).toBeNull();
        expect(yield* mobile.revokeSession("any-session").pipe(Effect.isFailure)).toBe(true);
        yield* analytics.record("fixture", { mustNotSend: true });
        yield* analytics.flush;
      }).pipe(Effect.provide(Layer.mergeAll(RemoteMobileControlLive, RemoteAnalyticsLive))),
    );
  });
});
