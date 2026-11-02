import { ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { BrowserManager, type BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { Open, type OpenShape } from "../../utils/open.ts";
import { ComputerUse } from "../Services/ComputerUse.ts";
import { CuaDriver, type CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUseLive } from "./ComputerUse.ts";

it("honors live settings and retains background targets across service calls", async () => {
  const threadId = ThreadId.makeUnsafe("delivery-setting-thread");
  let userChangedFocus = false;
  const callTool = vi.fn((name: string, _args: Record<string, unknown>) =>
    Effect.succeed({
      content:
        name === "get_window_state"
          ? [{ type: "image", data: "image", mimeType: "image/png" }]
          : [],
      structuredContent:
        name === "list_windows"
          ? {
              windows: [
                {
                  pid: 1,
                  window_id: 11,
                  app_name: "Notes",
                  z_index: userChangedFocus ? 1 : 3,
                  bounds: { x: 0, y: 0, width: 800, height: 600 },
                },
                {
                  pid: 2,
                  window_id: 22,
                  app_name: "Browser",
                  z_index: userChangedFocus ? 3 : 1,
                  bounds: { x: 0, y: 0, width: 800, height: 600 },
                },
              ],
            }
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
  const layer = ComputerUseLive.pipe(
    Layer.provide(Layer.succeed(CuaDriver, driver)),
    Layer.provide(Layer.succeed(BrowserManager, {} as BrowserManagerShape)),
    Layer.provide(Layer.succeed(Open, {} as OpenShape)),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ComputerUse;
      const settings = yield* ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
      VALUES ('delivery-project', 'Project', '{}', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')`;
      yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'delivery-project', 'Thread', '{}', 'full-access', 'default', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z')`;

      yield* service.execute(threadId, { action: "capture", surface: "desktop" });
      userChangedFocus = true;
      yield* service.execute(threadId, { action: "type", text: "hello", surface: "desktop" });
      expect(callTool).toHaveBeenCalledWith(
        "type_text",
        expect.objectContaining({ pid: 1, delivery_mode: "background" }),
      );

      yield* settings.updateSettings({ computerUseDeliveryMode: "foreground" });
      yield* service.execute(threadId, { action: "type", text: "foreground", surface: "desktop" });
      expect(callTool).toHaveBeenCalledWith(
        "type_text",
        expect.objectContaining({ pid: 2, delivery_mode: "foreground" }),
      );

      yield* settings.updateSettings({ computerUseDeliveryMode: "background" });
      const unselected = yield* Effect.result(
        service.execute(threadId, { action: "type", text: "do not send", surface: "desktop" }),
      );
      expect(unselected._tag).toBe("Failure");
      expect(callTool.mock.calls.filter(([name]) => name === "type_text")).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
  );
});
