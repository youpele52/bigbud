import type { ThreadId } from "@bigbud/contracts";
import { Data, ServiceMap } from "effect";
import type { Effect } from "effect";

export interface BrowserContextInfo {
  readonly threadId: ThreadId;
  readonly url: string;
  readonly title: string;
}

export interface BrowserScreenshotResult {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

export class BrowserManagerError extends Data.TaggedError("BrowserManagerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BrowserManagerShape {
  /**
   * Launch or attach to a browser context for the given thread.
   */
  readonly launch: (threadId: ThreadId) => Effect.Effect<void, BrowserManagerError>;

  /**
   * Navigate the browser context to a URL.
   */
  readonly navigate: (
    threadId: ThreadId,
    url: string,
  ) => Effect.Effect<BrowserContextInfo, BrowserManagerError>;

  /**
   * Take a screenshot of the current page.
   */
  readonly screenshot: (
    threadId: ThreadId,
  ) => Effect.Effect<BrowserScreenshotResult, BrowserManagerError>;

  /**
   * Get the current page info (URL, title).
   */
  readonly getPageInfo: (
    threadId: ThreadId,
  ) => Effect.Effect<BrowserContextInfo, BrowserManagerError>;

  /**
   * Close the browser context for the given thread.
   */
  readonly close: (threadId: ThreadId) => Effect.Effect<void, BrowserManagerError>;

  /**
   * Close all browser contexts.
   */
  readonly closeAll: () => Effect.Effect<void, BrowserManagerError>;
}

export class BrowserManager extends ServiceMap.Service<BrowserManager, BrowserManagerShape>()(
  "t3/browser/Services/BrowserManager",
) {}
