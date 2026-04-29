/**
 * BrowserActionHandler - Reactive browser tool execution for provider adapters.
 *
 * Bridges provider tool invocation events to BrowserManager operations.
 * When a provider adapter detects a browser-related tool call, it can
 * delegate execution here and emit results back into the event stream.
 *
 * @module BrowserActionHandler
 */
import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import { BrowserManager } from "./Services/BrowserManager.ts";

export interface BrowserNavigateInput {
  readonly threadId: ThreadId;
  readonly url: string;
}

export interface BrowserScreenshotInput {
  readonly threadId: ThreadId;
}

export interface BrowserGetPageInfoInput {
  readonly threadId: ThreadId;
}

/**
 * Execute a browser navigation and return page context.
 */
export const handleBrowserNavigate = (input: BrowserNavigateInput) =>
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    yield* browser.launch(input.threadId);
    const info = yield* browser.navigate(input.threadId, input.url);
    return info;
  });

/**
 * Take a browser screenshot and return image data.
 */
export const handleBrowserScreenshot = (input: BrowserScreenshotInput) =>
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    yield* browser.launch(input.threadId);
    const result = yield* browser.screenshot(input.threadId);
    return result;
  });

/**
 * Get current page info without changing state.
 */
export const handleBrowserGetPageInfo = (input: BrowserGetPageInfoInput) =>
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    yield* browser.launch(input.threadId);
    const info = yield* browser.getPageInfo(input.threadId);
    return info;
  });

/**
 * Clean up browser context for a thread.
 */
export const handleBrowserClose = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const browser = yield* BrowserManager;
    yield* browser.close(threadId);
  });
