import { ThreadId } from "@bigbud/contracts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

import { BrowserManager, type BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import { CuaDriver, type CuaDriverShape } from "../Services/CuaDriver.ts";
import { ComputerUse } from "../Services/ComputerUse.ts";
import { ComputerUseLive } from "./ComputerUse.ts";
import { Open, OpenError, type OpenShape } from "../../utils/open.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

const open: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
  openPath: () => Effect.void,
};

describe("ComputerUseLive", () => {
  it("prevents a concurrent action from starting after deletion is claimed", async () => {
    const release = await Effect.runPromise(Deferred.make<void>());
    const wait = vi.fn(() => Deferred.await(release));
    const layer = ComputerUseLive.pipe(
      Layer.provide(
        Layer.succeed(BrowserManager, {
          launch: () => Effect.void,
          wait,
          getPageInfo: () =>
            Effect.succeed({ threadId: THREAD_ID, url: "https://example.com", title: "Example" }),
        } as unknown as BrowserManagerShape),
      ),
      Layer.provide(Layer.succeed(CuaDriver, { dispose: Effect.void } as CuaDriverShape)),
      Layer.provide(Layer.succeed(Open, open)),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const computerUse = yield* ComputerUse;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects (project_id, title, scripts_json, created_at, updated_at)
          VALUES ('computer-race-project', 'Project', '{}', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, created_at, updated_at
          ) VALUES (${THREAD_ID}, 'computer-race-project', 'Thread', '{}', 'full-access',
            'default', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')
        `;
        const first = yield* computerUse
          .execute(THREAD_ID, { action: "wait", durationMs: 1 })
          .pipe(Effect.forkChild);
        while (
          (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM thread_activity_leases WHERE thread_id = ${THREAD_ID}
          `)[0]?.count !== 1
        ) {
          yield* Effect.yieldNow;
        }
        yield* sql`UPDATE projection_threads SET deleting_at = '2026-08-04T00:00:01.000Z'
          WHERE thread_id = ${THREAD_ID}`;
        const late = yield* Effect.exit(computerUse.withThreadLease!(THREAD_ID, Effect.void));
        expect(late._tag).toBe("Failure");
        expect(wait).toHaveBeenCalledTimes(1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("keeps a thread active until all concurrent actions finish", async () => {
    const program = Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const browser = {
        launch: () => Effect.void,
        wait: (_threadId: ThreadId, durationMs: number) =>
          Deferred.await(durationMs === 1 ? first : second),
        getPageInfo: () =>
          Effect.succeed({ threadId: THREAD_ID, url: "https://example.com", title: "Example" }),
      } as unknown as BrowserManagerShape;
      const layer = ComputerUseLive.pipe(
        Layer.provide(Layer.succeed(BrowserManager, browser)),
        Layer.provide(Layer.succeed(CuaDriver, { dispose: Effect.void } as CuaDriverShape)),
        Layer.provide(Layer.succeed(Open, open)),
        Layer.provide(SqlitePersistenceMemory),
      );

      yield* Effect.gen(function* () {
        const computerUse = yield* ComputerUse;
        const firstFiber = yield* computerUse
          .execute(THREAD_ID, { action: "wait", durationMs: 1 })
          .pipe(Effect.forkChild);
        const secondFiber = yield* computerUse
          .execute(THREAD_ID, { action: "wait", durationMs: 2 })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* computerUse.isActive!(THREAD_ID)).toBe(true);
        yield* Deferred.succeed(first, undefined);
        yield* Fiber.join(firstFiber);
        expect(yield* computerUse.isActive!(THREAD_ID)).toBe(true);
        yield* Deferred.succeed(second, undefined);
        yield* Fiber.join(secondFiber);
        expect(yield* computerUse.isActive!(THREAD_ID)).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    await Effect.runPromise(program);
  });

  it("opens desktop navigation in the system browser without using BrowserManager", async () => {
    const browserNavigate = vi.fn(() => Effect.die("unexpected in-app browser navigate"));
    const openBrowser = vi.fn(() => Effect.void);
    const browser = {
      launch: () => Effect.die("unexpected browser launch"),
      navigate: browserNavigate,
    } as unknown as BrowserManagerShape;
    const driver = {
      callTool: () => Effect.die("unexpected cua driver call"),
      dispose: Effect.void,
    } as unknown as CuaDriverShape;
    const layer = ComputerUseLive.pipe(
      Layer.provide(Layer.succeed(BrowserManager, browser)),
      Layer.provide(Layer.succeed(CuaDriver, driver)),
      Layer.provide(Layer.succeed(Open, { ...open, openBrowser })),
      Layer.provide(SqlitePersistenceMemory),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const computerUse = yield* ComputerUse;
        return yield* computerUse.execute(THREAD_ID, {
          action: "navigate",
          surface: "desktop",
          url: "https://example.com/path",
          captureAfter: true,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(openBrowser).toHaveBeenCalledExactlyOnceWith("https://example.com/path");
    expect(browserNavigate).not.toHaveBeenCalled();
    expect(result).toEqual({
      surface: "desktop",
      action: "navigate",
      summary:
        "Opened https://example.com/path in the system default browser. Browser control has not been confirmed.",
    });
  });

  it("surfaces system browser opener failures", async () => {
    const openBrowser = vi.fn(() =>
      Effect.fail(new OpenError({ message: "Browser auto-open failed" })),
    );
    const layer = ComputerUseLive.pipe(
      Layer.provide(Layer.succeed(BrowserManager, {} as BrowserManagerShape)),
      Layer.provide(Layer.succeed(CuaDriver, { dispose: Effect.void } as CuaDriverShape)),
      Layer.provide(Layer.succeed(Open, { ...open, openBrowser })),
      Layer.provide(SqlitePersistenceMemory),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const computerUse = yield* ComputerUse;
          return yield* computerUse.execute(THREAD_ID, {
            action: "navigate",
            surface: "desktop",
            url: "https://example.com/failure",
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Failed to open the system default browser: Browser auto-open failed");
  });

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
      getPageText: () => Effect.die("unexpected browser page text"),
      goBack: () => Effect.die("unexpected browser back"),
      goForward: () => Effect.die("unexpected browser forward"),
      reload: () => Effect.die("unexpected browser reload"),
      close: () => Effect.void,
      closeAll: () => Effect.void,
    };
    const driver: CuaDriverShape = {
      callTool,
      runDoctor: () => Effect.succeed("ok"),
      resetProxy: Effect.void,
      resetAfterUncertainAction: () => Effect.void,
      withExclusiveAccess: (effect) => effect,
      dispose: Effect.void,
    };

    const layer = ComputerUseLive.pipe(
      Layer.provide(Layer.succeed(BrowserManager, browser)),
      Layer.provide(Layer.succeed(CuaDriver, driver)),
      Layer.provide(Layer.succeed(Open, open)),
      Layer.provide(SqlitePersistenceMemory),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const computerUse = yield* ComputerUse;
        return yield* computerUse.execute(THREAD_ID, { action: "list_apps" });
      }).pipe(Effect.provide(layer)),
    );

    expect(browserLaunch).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith(
      "list_apps",
      expect.objectContaining({ session: expect.stringMatching(/^bigbud-/) }),
    );
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
      getPageText: () => Effect.die("unexpected browser page text"),
      goBack: () => Effect.die("unexpected browser back"),
      goForward: () => Effect.die("unexpected browser forward"),
      reload: () => Effect.die("unexpected browser reload"),
      close: () => Effect.void,
      closeAll: () => Effect.void,
    };
    const driver: CuaDriverShape = {
      callTool,
      runDoctor: () => Effect.succeed("ok"),
      resetProxy: Effect.void,
      resetAfterUncertainAction: () => Effect.void,
      withExclusiveAccess: (effect) => effect,
      dispose: Effect.void,
    };

    const layer = ComputerUseLive.pipe(
      Layer.provide(Layer.succeed(BrowserManager, browser)),
      Layer.provide(Layer.succeed(CuaDriver, driver)),
      Layer.provide(Layer.succeed(Open, open)),
      Layer.provide(SqlitePersistenceMemory),
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
