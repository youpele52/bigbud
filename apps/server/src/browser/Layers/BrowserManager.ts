/**
 * BrowserManagerLive - Playwright-based browser automation service.
 *
 * Manages Chromium browser contexts per thread, supporting navigation,
 * screenshots, and page introspection for agent-driven web tasks.
 *
 * @module BrowserManagerLive
 */
import { BROWSER_PAGE_TEXT_MAX_CHARS, type ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BrowserManager,
  type BrowserManagerShape,
  BrowserManagerError,
} from "../Services/BrowserManager.ts";

interface ThreadBrowserContext {
  readonly context: import("playwright").BrowserContext;
  readonly page: import("playwright").Page;
}

const browserLeaseId = (threadId: ThreadId) => `background-browser:${threadId}`;

const makeBrowserManager = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const contextSemaphore = yield* Semaphore.make(1);
  const contexts = new Map<ThreadId, ThreadBrowserContext>();
  let browser: import("playwright").Browser | null = null;
  yield* sql`DELETE FROM thread_activity_leases WHERE lease_id LIKE 'background-browser:%'`;

  const releaseLease = (threadId: ThreadId) =>
    sql`DELETE FROM thread_activity_leases WHERE lease_id = ${browserLeaseId(threadId)}`.pipe(
      Effect.ignore,
    );

  const getBrowser = (): Effect.Effect<import("playwright").Browser, BrowserManagerError> =>
    Effect.gen(function* () {
      if (browser) {
        return browser;
      }
      const pw = yield* Effect.tryPromise({
        try: () => import("playwright"),
        catch: (cause) =>
          new BrowserManagerError({
            message: "Failed to load Playwright. Is it installed?",
            cause,
          }),
      });
      const launched = yield* Effect.tryPromise({
        try: () => pw.chromium.launch({ headless: true }),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to launch Chromium browser.", cause }),
      });
      browser = launched;
      return launched;
    });

  const createContext = (
    threadId: ThreadId,
  ): Effect.Effect<ThreadBrowserContext, BrowserManagerError> =>
    Effect.gen(function* () {
      const existing = contexts.get(threadId);
      if (existing) {
        return existing;
      }
      yield* sql`
        INSERT INTO thread_activity_leases (lease_id, thread_id, activity_kind, acquired_at)
        VALUES (${browserLeaseId(threadId)}, ${threadId}, 'browser', ${new Date().toISOString()})
      `.pipe(
        Effect.mapError(
          (cause) =>
            new BrowserManagerError({
              message: "Browser context cannot start while the thread is being deleted.",
              cause,
            }),
        ),
      );
      const b = yield* getBrowser().pipe(Effect.tapError(() => releaseLease(threadId)));
      const context = yield* Effect.tryPromise({
        try: () => b.newContext({ viewport: { width: 1280, height: 720 } }),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to create browser context.", cause }),
      }).pipe(Effect.tapError(() => releaseLease(threadId)));
      const page = yield* Effect.tryPromise({
        try: () => context.newPage(),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to create browser page.", cause }),
      }).pipe(
        Effect.tapError(() =>
          Effect.all(
            [Effect.promise(() => context.close()).pipe(Effect.ignore), releaseLease(threadId)],
            {
              discard: true,
            },
          ),
        ),
      );
      const record: ThreadBrowserContext = { context, page };
      contexts.set(threadId, record);
      return record;
    });

  const getContext = (threadId: ThreadId) =>
    contextSemaphore.withPermits(1)(createContext(threadId));

  const launch: BrowserManagerShape["launch"] = (threadId) =>
    Effect.map(getContext(threadId), () => undefined);

  const navigate: BrowserManagerShape["navigate"] = (threadId, url) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: () => record.page.goto(url, { waitUntil: "domcontentloaded" }),
        catch: (cause) =>
          new BrowserManagerError({ message: `Failed to navigate to ${url}.`, cause }),
      });
      const pageUrl = record.page.url();
      const title = yield* Effect.tryPromise({
        try: () => record.page.title(),
        catch: () => "",
      }).pipe(Effect.catch(() => Effect.succeed("")));
      return { threadId, url: pageUrl, title };
    });

  const screenshot: BrowserManagerShape["screenshot"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      const buffer = yield* Effect.tryPromise({
        try: () => record.page.screenshot({ type: "png", fullPage: false }),
        catch: (cause) => new BrowserManagerError({ message: "Failed to take screenshot.", cause }),
      });
      return { data: new Uint8Array(buffer), mimeType: "image/png" };
    });

  const click: BrowserManagerShape["click"] = (threadId, input) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: async () => {
          await record.page.mouse.click(input.x, input.y, {
            button: input.button ?? "left",
          });
        },
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to click in browser page.", cause }),
      });
    });

  const drag: BrowserManagerShape["drag"] = (threadId, input) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: async () => {
          await record.page.mouse.move(input.startX, input.startY);
          await record.page.mouse.down();
          await record.page.mouse.move(input.endX, input.endY, { steps: 12 });
          await record.page.mouse.up();
        },
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to drag in browser page.", cause }),
      });
    });

  const scroll: BrowserManagerShape["scroll"] = (threadId, input) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: async () => {
          if (input.x !== undefined && input.y !== undefined) {
            await record.page.mouse.move(input.x, input.y);
          }
          await record.page.mouse.wheel(input.deltaX ?? 0, input.deltaY ?? 0);
        },
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to scroll browser page.", cause }),
      });
    });

  const typeText: BrowserManagerShape["typeText"] = (threadId, text) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: () => record.page.keyboard.type(text),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to type in browser page.", cause }),
      });
    });

  const keyPress: BrowserManagerShape["keyPress"] = (threadId, key) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: () => record.page.keyboard.press(key),
        catch: (cause) =>
          new BrowserManagerError({ message: `Failed to press key "${key}".`, cause }),
      });
    });

  const wait: BrowserManagerShape["wait"] = (_threadId, durationMs) =>
    Effect.sleep(`${Math.max(1, Math.round(durationMs))} millis`);

  const getPageInfo: BrowserManagerShape["getPageInfo"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      const pageUrl = record.page.url();
      const title = yield* Effect.tryPromise({
        try: () => record.page.title(),
        catch: () => "",
      }).pipe(Effect.catch(() => Effect.succeed("")));
      return { threadId, url: pageUrl, title };
    });

  const getPageText: BrowserManagerShape["getPageText"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      const text = yield* Effect.tryPromise({
        try: () => record.page.locator("body").innerText(),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to read browser page text.", cause }),
      });
      return text.slice(0, BROWSER_PAGE_TEXT_MAX_CHARS);
    });

  const currentPageInfo = (threadId: ThreadId, record: ThreadBrowserContext) =>
    Effect.gen(function* () {
      const title = yield* Effect.tryPromise({
        try: () => record.page.title(),
        catch: () => "",
      }).pipe(Effect.catch(() => Effect.succeed("")));
      return { threadId, url: record.page.url(), title };
    });

  const goBack: BrowserManagerShape["goBack"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: () => record.page.goBack({ waitUntil: "domcontentloaded" }),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to go back in browser.", cause }),
      });
      return yield* currentPageInfo(threadId, record);
    });

  const goForward: BrowserManagerShape["goForward"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: () => record.page.goForward({ waitUntil: "domcontentloaded" }),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to go forward in browser.", cause }),
      });
      return yield* currentPageInfo(threadId, record);
    });

  const reload: BrowserManagerShape["reload"] = (threadId) =>
    Effect.gen(function* () {
      const record = yield* getContext(threadId);
      yield* Effect.tryPromise({
        try: () => record.page.reload({ waitUntil: "domcontentloaded" }),
        catch: (cause) => new BrowserManagerError({ message: "Failed to reload browser.", cause }),
      });
      return yield* currentPageInfo(threadId, record);
    });

  const close: BrowserManagerShape["close"] = (threadId) =>
    Effect.gen(function* () {
      const record = contexts.get(threadId);
      if (!record) {
        yield* releaseLease(threadId);
        return;
      }
      contexts.delete(threadId);
      yield* Effect.tryPromise({
        try: () => record.context.close(),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
      yield* releaseLease(threadId);
    });

  const closeAll: BrowserManagerShape["closeAll"] = () =>
    Effect.gen(function* () {
      for (const [threadId] of contexts) {
        yield* close(threadId);
      }
      if (browser) {
        const b = browser;
        browser = null;
        yield* Effect.tryPromise({
          try: () => b.close(),
          catch: () => undefined,
        }).pipe(Effect.catch(() => Effect.void));
      }
    });

  return {
    hasContext: (threadId) => Effect.sync(() => contexts.has(threadId)),
    launch,
    navigate,
    screenshot,
    click,
    drag,
    scroll,
    typeText,
    keyPress,
    wait,
    getPageInfo,
    getPageText,
    goBack,
    goForward,
    reload,
    close,
    closeAll,
  } satisfies BrowserManagerShape;
});

export const BrowserManagerLive = Layer.effect(BrowserManager, makeBrowserManager);
