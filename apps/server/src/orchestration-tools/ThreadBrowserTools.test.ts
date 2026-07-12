import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { browserViaOrchestration } from "./ThreadBrowserTools.ts";

describe("browserViaOrchestration", () => {
  it("runs independently of desktop computer-use settings", async () => {
    const navigate = vi.fn(() =>
      Effect.succeed({
        threadId: ThreadId.makeUnsafe("thread-browser"),
        url: "https://example.com",
        title: "Example",
      }),
    );
    const result = await Effect.runPromise(
      browserViaOrchestration({
        browser: {
          launch: () => Effect.void,
          navigate,
          screenshot: () => Effect.die("unexpected screenshot"),
          click: () => Effect.void,
          drag: () => Effect.void,
          scroll: () => Effect.void,
          typeText: () => Effect.void,
          keyPress: () => Effect.void,
          wait: () => Effect.void,
          getPageInfo: () => Effect.die("unexpected page info"),
          getPageText: () => Effect.die("unexpected page text"),
          goBack: () => Effect.die("unexpected browser back"),
          goForward: () => Effect.die("unexpected browser forward"),
          reload: () => Effect.die("unexpected browser reload"),
          close: () => Effect.void,
          closeAll: () => Effect.void,
        },
        threadId: ThreadId.makeUnsafe("thread-browser"),
        action: { action: "navigate", url: "https://example.com" },
      }),
    );

    expect(navigate).toHaveBeenCalledWith(
      ThreadId.makeUnsafe("thread-browser"),
      "https://example.com",
    );
    expect(result).toMatchObject({
      action: "navigate",
      page: { url: "https://example.com", title: "Example" },
    });
  });

  it("includes a screenshot for capture actions", async () => {
    const result = await Effect.runPromise(
      browserViaOrchestration({
        browser: {
          launch: () => Effect.void,
          navigate: () => Effect.die("unexpected navigation"),
          screenshot: () =>
            Effect.succeed({ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }),
          click: () => Effect.void,
          drag: () => Effect.void,
          scroll: () => Effect.void,
          typeText: () => Effect.void,
          keyPress: () => Effect.void,
          wait: () => Effect.void,
          getPageInfo: () => Effect.die("unexpected page info"),
          getPageText: () => Effect.die("unexpected page text"),
          goBack: () => Effect.die("unexpected browser back"),
          goForward: () => Effect.die("unexpected browser forward"),
          reload: () => Effect.die("unexpected browser reload"),
          close: () => Effect.void,
          closeAll: () => Effect.void,
        },
        threadId: ThreadId.makeUnsafe("thread-browser"),
        action: { action: "capture" },
      }),
    );

    expect("screenshot" in result ? result.screenshot : undefined).toEqual({
      dataBase64: "AQID",
      mimeType: "image/png",
    });
  });

  it("returns visible page text for inspection", async () => {
    const getPageText = vi.fn(() => Effect.succeed("First story\nSecond story"));
    const result = await Effect.runPromise(
      browserViaOrchestration({
        browser: {
          launch: () => Effect.void,
          navigate: () => Effect.die("unexpected navigation"),
          screenshot: () => Effect.die("unexpected screenshot"),
          click: () => Effect.void,
          drag: () => Effect.void,
          scroll: () => Effect.void,
          typeText: () => Effect.void,
          keyPress: () => Effect.void,
          wait: () => Effect.void,
          getPageInfo: () => Effect.die("unexpected page info"),
          getPageText,
          goBack: () => Effect.die("unexpected browser back"),
          goForward: () => Effect.die("unexpected browser forward"),
          reload: () => Effect.die("unexpected browser reload"),
          close: () => Effect.void,
          closeAll: () => Effect.void,
        },
        threadId: ThreadId.makeUnsafe("thread-browser"),
        action: { action: "get_page_text" },
      }),
    );

    expect(getPageText).toHaveBeenCalledWith(ThreadId.makeUnsafe("thread-browser"));
    expect(result).toMatchObject({
      action: "get_page_text",
      text: "First story\nSecond story",
    });
  });
});
