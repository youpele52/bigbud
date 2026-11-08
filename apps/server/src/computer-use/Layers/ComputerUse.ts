import type { ComputerUseAction } from "@bigbud/contracts";
import { resolveComputerUseSurface } from "@bigbud/shared/computer-use/surface";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { Open } from "../../utils/open.ts";
import { executeBrowserComputerUse } from "./ComputerUse.browser.ts";
import { executeDesktopComputerUse } from "./ComputerUse.desktop.ts";
import { CuaDriver } from "../Services/CuaDriver.ts";
import { ComputerUse, ComputerUseError, type ComputerUseShape } from "../Services/ComputerUse.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { createDesktopTargets } from "./ComputerUse.desktop.interaction.ts";
import {
  holdThreadLease,
  releaseThreadLease,
  threadLeaseExpiresAt,
} from "../../retention/threadLeaseHeartbeat.ts";

function resolveSurface(action: ComputerUseAction): "browser" | "desktop" {
  return resolveComputerUseSurface(action.action, "surface" in action ? action.surface : undefined);
}

export function isDesktopSurfaceAction(action: ComputerUseAction): boolean {
  return resolveSurface(action) === "desktop";
}

export const ComputerUseLive = Layer.effect(
  ComputerUse,
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    const cuaDriver = yield* CuaDriver;
    const { openBrowser } = yield* Open;
    const sql = yield* SqlClient.SqlClient;
    const settingsService = yield* ServerSettingsService;
    const targets = createDesktopTargets();
    const activeThreadActions = new Map<string, number>();

    const beginAction = (threadId: string) =>
      Effect.sync(() => {
        activeThreadActions.set(threadId, (activeThreadActions.get(threadId) ?? 0) + 1);
      });
    const endAction = (threadId: string) =>
      Effect.sync(() => {
        const remaining = (activeThreadActions.get(threadId) ?? 1) - 1;
        if (remaining === 0) activeThreadActions.delete(threadId);
        else activeThreadActions.set(threadId, remaining);
      });

    const withThreadLease: NonNullable<ComputerUseShape["withThreadLease"]> = (
      threadId,
      effect,
    ) => {
      const leaseId = crypto.randomUUID();
      return Effect.acquireUseRelease(
        sql`
          INSERT INTO thread_activity_leases (
            lease_id, thread_id, activity_kind, acquired_at, expires_at
          ) VALUES (${leaseId}, ${threadId}, 'computer-use', ${new Date().toISOString()},
            ${threadLeaseExpiresAt()})
        `.pipe(
          Effect.asVoid,
          Effect.tap(() => Effect.sync(() => holdThreadLease(leaseId))),
          Effect.mapError(
            (cause) =>
              new ComputerUseError({
                message: "Computer use cannot start while the thread is being deleted.",
                cause,
              }),
          ),
        ),
        () =>
          beginAction(threadId).pipe(Effect.andThen(effect), Effect.ensuring(endAction(threadId))),
        () =>
          sql`DELETE FROM thread_activity_leases WHERE lease_id = ${leaseId}`.pipe(
            Effect.ignore,
            Effect.ensuring(Effect.sync(() => releaseThreadLease(leaseId))),
          ),
      );
    };

    const execute: ComputerUseShape["execute"] = (threadId, action) =>
      withThreadLease(
        threadId,
        resolveSurface(action) === "desktop"
          ? settingsService.getSettings.pipe(
              Effect.mapError(
                (cause) =>
                  new ComputerUseError({
                    message: "Could not read Computer Use interaction settings.",
                    cause,
                  }),
              ),
              Effect.flatMap((settings) =>
                executeDesktopComputerUse(threadId, cuaDriver, action, openBrowser, {
                  deliveryMode: settings.computerUseDeliveryMode,
                  targets,
                }),
              ),
            )
          : executeBrowserComputerUse(browser, threadId, action),
      );

    return {
      execute,
      withThreadLease,
      isActive: (threadId) => Effect.sync(() => activeThreadActions.has(threadId)),
      dispose: cuaDriver.dispose.pipe(Effect.ensuring(Effect.sync(() => targets.clear()))),
    };
  }),
);
