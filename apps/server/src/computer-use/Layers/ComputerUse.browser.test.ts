import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import { executeBrowserComputerUse } from "./ComputerUse.browser.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-11111111-1111-4111-8111-111111111111");

function makeBrowser(overrides: Partial<BrowserManagerShape> = {}): BrowserManagerShape {
  const page = {
    threadId: THREAD_ID,
    url: "https://example.com",
    title: "Example",
  };
  return {
    launch: () => Effect.void,
    navigate: () => Effect.succeed(page),
    screenshot: () =>
      Effect.succeed({
        data: Uint8Array.from([137, 80, 78, 71]),
        mimeType: "image/png",
      }),
    click: () => Effect.void,
    drag: () => Effect.void,
    scroll: () => Effect.void,
    typeText: () => Effect.void,
    keyPress: () => Effect.void,
    wait: () => Effect.void,
    getPageInfo: () => Effect.succeed(page),
    close: () => Effect.void,
    closeAll: () => Effect.void,
    ...overrides,
  };
}

describe("executeBrowserComputerUse", () => {
  it("captures a screenshot for capture actions", async () => {
    const screenshot = vi.fn(() =>
      Effect.succeed({
        data: Uint8Array.from([1, 2, 3]),
        mimeType: "image/png",
      }),
    );
    const browser = makeBrowser({ screenshot });

    const result = await Effect.runPromise(
      executeBrowserComputerUse(browser, THREAD_ID, { action: "capture" }),
    );

    expect(screenshot).toHaveBeenCalledOnce();
    expect(result.surface).toBe("browser");
    expect(result.screenshot).toEqual({
      mimeType: "image/png",
      dataBase64: Buffer.from([1, 2, 3]).toString("base64"),
    });
  });

  it("does not capture a screenshot for get_page_info", async () => {
    const screenshot = vi.fn(() =>
      Effect.succeed({
        data: Uint8Array.from([1, 2, 3]),
        mimeType: "image/png",
      }),
    );
    const browser = makeBrowser({ screenshot });

    const result = await Effect.runPromise(
      executeBrowserComputerUse(browser, THREAD_ID, { action: "get_page_info" }),
    );

    expect(screenshot).not.toHaveBeenCalled();
    expect(result.page).toEqual({
      url: "https://example.com",
      title: "Example",
    });
    expect(result.screenshot).toBeUndefined();
  });

  it("captures after mutating actions when captureAfter is true", async () => {
    const click = vi.fn(() => Effect.void);
    const screenshot = vi.fn(() =>
      Effect.succeed({
        data: Uint8Array.from([9, 9, 9]),
        mimeType: "image/png",
      }),
    );
    const browser = makeBrowser({ click, screenshot });

    const result = await Effect.runPromise(
      executeBrowserComputerUse(browser, THREAD_ID, {
        action: "click",
        x: 10,
        y: 20,
        captureAfter: true,
      }),
    );

    expect(click).toHaveBeenCalledOnce();
    expect(screenshot).toHaveBeenCalledOnce();
    expect(result.summary).toContain("Clicked left at (10, 20)");
    expect(result.screenshot?.dataBase64).toBe(Buffer.from([9, 9, 9]).toString("base64"));
  });

  it("rejects desktop-only actions on the browser surface", async () => {
    const browser = makeBrowser();

    await expect(
      Effect.runPromise(executeBrowserComputerUse(browser, THREAD_ID, { action: "list_apps" })),
    ).rejects.toThrow("not supported on the browser surface");
  });
});
