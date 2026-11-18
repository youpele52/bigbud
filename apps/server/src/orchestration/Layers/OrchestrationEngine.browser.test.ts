import {
  ThreadId,
  TurnId,
  type BrowserResult,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { BrowserManagerShape } from "../../browser/Services/BrowserManager.ts";
import type { VisibleBrowserControlShape } from "../../browser/Services/VisibleBrowserControl.ts";
import { executeBrowserAction } from "./OrchestrationEngine.browser.ts";

const THREAD_ID = ThreadId.makeUnsafe("browser-routing-thread");
const TURN_ID = TurnId.makeUnsafe("browser-routing-turn");

const readModel = () =>
  ({
    threads: [
      {
        id: THREAD_ID,
        latestTurn: null,
        session: { status: "running", activeTurnId: TURN_ID },
      },
    ],
  }) as unknown as OrchestrationReadModel;

function browser(): BrowserManagerShape {
  return {
    launch: () => Effect.void,
    navigate: () => Effect.die("unexpected navigate"),
    screenshot: () => Effect.succeed({ data: Uint8Array.from([]), mimeType: "image/png" }),
    click: () => Effect.die("unexpected click"),
    drag: () => Effect.die("unexpected drag"),
    scroll: () => Effect.die("unexpected scroll"),
    typeText: () => Effect.die("unexpected type"),
    keyPress: () => Effect.die("unexpected key"),
    wait: () => Effect.die("unexpected wait"),
    getPageInfo: () => Effect.die("unexpected page info"),
    getPageText: () => Effect.die("unexpected page text"),
    goBack: () => Effect.die("unexpected go back"),
    goForward: () => Effect.die("unexpected go forward"),
    reload: () => Effect.die("unexpected reload"),
    close: () => Effect.void,
    closeAll: () => Effect.void,
  };
}

function visibleBrowser(tabId: string | undefined) {
  let resolvedTabId = tabId;
  const execute = vi.fn<() => Effect.Effect<BrowserResult, Error>>(() =>
    Effect.succeed({
      action: "capture",
      summary: "Captured visible browser.",
      target: "visible",
    } as BrowserResult),
  );
  const resolveThreadLease = vi.fn(() => Effect.succeed(resolvedTabId));
  return {
    control: {
      resolveThreadLease,
      execute,
    } as unknown as VisibleBrowserControlShape,
    execute,
    release: () => {
      resolvedTabId = undefined;
    },
  };
}

function execute(input: {
  readonly browser: BrowserManagerShape;
  readonly visibleBrowser: VisibleBrowserControlShape;
  readonly target?: "auto" | "visible" | "background";
  readonly tabId?: string;
}): Promise<BrowserResult> {
  return Effect.runPromise(
    executeBrowserAction({
      browser: input.browser,
      readModel,
      threadId: THREAD_ID,
      action: {
        action: "capture",
        ...(input.target ? { target: input.target } : {}),
        ...(input.tabId ? { tabId: input.tabId } : {}),
      },
      visibleBrowser: input.visibleBrowser,
    }),
  );
}

describe("executeBrowserAction", () => {
  it("continues the calling thread's resolved visible tab for auto actions", async () => {
    const visible = visibleBrowser("browser:owned-tab");

    await expect(
      execute({ browser: browser(), visibleBrowser: visible.control }),
    ).resolves.toMatchObject({
      target: "visible",
    });
    expect(visible.execute).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      action: { action: "capture", tabId: "browser:owned-tab" },
    });
  });

  it("uses the background browser when auto has no owned visible lease", async () => {
    const browserManager = browser();
    const launch = vi.spyOn(browserManager, "launch");
    const visible = visibleBrowser(undefined);

    await expect(
      execute({ browser: browserManager, visibleBrowser: visible.control }),
    ).resolves.toMatchObject({
      target: "background",
    });
    expect(launch).toHaveBeenCalledWith(THREAD_ID);
    expect(visible.execute).not.toHaveBeenCalled();
  });

  it("uses the background browser after a released or revoked lease no longer resolves", async () => {
    const browserManager = browser();
    const launch = vi.spyOn(browserManager, "launch");
    const visible = visibleBrowser("browser:released-tab");

    await execute({ browser: browserManager, visibleBrowser: visible.control });
    visible.release();
    await execute({ browser: browserManager, visibleBrowser: visible.control });

    expect(visible.execute).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(THREAD_ID);
  });

  it("preserves a visible reconnect failure for an owned auto lease", async () => {
    const browserManager = browser();
    const visible = visibleBrowser("browser:owned-tab");
    visible.execute.mockReturnValue(
      Effect.fail(
        new Error("The visible browser tab is reconnecting. Try again once it is connected."),
      ),
    );

    await expect(
      execute({ browser: browserManager, visibleBrowser: visible.control }),
    ).rejects.toThrow("The visible browser tab is reconnecting. Try again once it is connected.");
    expect(visible.execute).toHaveBeenCalledOnce();
    expect(vi.spyOn(browserManager, "launch")).not.toHaveBeenCalled();
  });

  it("keeps explicit visible and background targets independent from auto resolution", async () => {
    const browserManager = browser();
    const launch = vi.spyOn(browserManager, "launch");
    const visible = visibleBrowser("browser:owned-tab");

    await execute({ browser: browserManager, visibleBrowser: visible.control, target: "visible" });
    await execute({
      browser: browserManager,
      visibleBrowser: visible.control,
      target: "background",
      tabId: "browser:other-tab",
    });

    expect(visible.control.resolveThreadLease).not.toHaveBeenCalled();
    expect(visible.execute).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      action: { action: "capture", target: "visible" },
    });
    expect(launch).toHaveBeenCalledWith(THREAD_ID);
  });
});
