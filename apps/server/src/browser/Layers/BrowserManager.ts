/**
 * BrowserManagerLive - Playwright-based browser automation service.
 *
 * Manages Chromium browser contexts per thread, supporting navigation,
 * screenshots, and page introspection for agent-driven web tasks.
 *
 * @module BrowserManagerLive
 */
import type { ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";

import {
  BrowserManager,
  type BrowserManagerShape,
  BrowserManagerError,
} from "../Services/BrowserManager.ts";

interface ThreadBrowserContext {
  readonly context: import("playwright").BrowserContext;
  readonly page: import("playwright").Page;
}

function makeBrowserManager(): BrowserManagerShape {
  const contexts = new Map<ThreadId, ThreadBrowserContext>();
  let browser: import("playwright").Browser | null = null;

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

  const getContext = (
    threadId: ThreadId,
  ): Effect.Effect<ThreadBrowserContext, BrowserManagerError> =>
    Effect.gen(function* () {
      const existing = contexts.get(threadId);
      if (existing) {
        return existing;
      }
      const b = yield* getBrowser();
      const context = yield* Effect.tryPromise({
        try: () => b.newContext({ viewport: { width: 1280, height: 720 } }),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to create browser context.", cause }),
      });
      const page = yield* Effect.tryPromise({
        try: () => context.newPage(),
        catch: (cause) =>
          new BrowserManagerError({ message: "Failed to create browser page.", cause }),
      });
      const record: ThreadBrowserContext = { context, page };
      contexts.set(threadId, record);
      return record;
    });

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

  const close: BrowserManagerShape["close"] = (threadId) =>
    Effect.gen(function* () {
      const record = contexts.get(threadId);
      if (!record) {
        return;
      }
      contexts.delete(threadId);
      yield* Effect.tryPromise({
        try: () => record.context.close(),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.void));
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
    launch,
    navigate,
    screenshot,
    getPageInfo,
    close,
    closeAll,
  };
}

export const BrowserManagerLive = Layer.effect(
  BrowserManager,
  Effect.sync(() => makeBrowserManager()),
);
