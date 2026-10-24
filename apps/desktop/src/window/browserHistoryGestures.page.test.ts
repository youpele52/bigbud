import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createHistorySwipeRecognizer } from "./browserHistoryGestures.logic";
import { installBrowserHistoryGestures } from "./browserHistoryGestures.page";

function setup(diagnostics = true) {
  let time = 0;
  let wheel: ((event: unknown) => void) | undefined;
  class FakeElement {
    localName = "div";
    scrollWidth = 100;
    clientWidth = 100;
    matches() {
      return false;
    }
  }
  const context = {
    performance: { now: () => time },
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "wheel") wheel = listener;
      },
      removeEventListener: () => {},
    },
    Element: FakeElement,
    document: { scrollingElement: null },
    getComputedStyle: () => ({ overscrollBehaviorX: "auto", overflowX: "visible" }),
    queueMicrotask: (callback: () => void) => callback(),
    history: { back: () => {}, forward: () => {} },
  };
  // Verify the actual serialization boundary, not a direct call with module closures available.
  const controller = runInNewContext(
    `(${installBrowserHistoryGestures.toString()})(${createHistorySwipeRecognizer.toString()}, 1, ${diagnostics}); globalThis.__bigbudHistoryGestures`,
    context,
  ) as {
    begin(): void;
    end(): string | null;
    drainDiagnostics(): Array<{ event: string; details?: Record<string, unknown> }>;
  };
  const send = (path: FakeElement[] = []) => {
    time += 20;
    wheel?.({
      isTrusted: true,
      deltaX: -80,
      deltaY: 0,
      deltaMode: 0,
      buttons: 0,
      composedPath: () => path,
    });
  };
  return {
    controller,
    send,
    FakeElement,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("private page gesture diagnostics", () => {
  it("preserves recognition with diagnostics disabled and stores no samples", () => {
    const { controller, send } = setup(false);
    controller.begin();
    send();
    send();
    send();
    expect(controller.end()).toBe("back");
    expect(controller.drainDiagnostics()).toEqual([]);
  });

  it("reports recognizer totals and site-filter rejection without page text or element names", () => {
    const { controller, send, FakeElement } = setup();
    controller.begin();
    send();
    send();
    send();
    expect(controller.end()).toBe("back");
    expect(controller.drainDiagnostics()).toContainEqual(
      expect.objectContaining({
        event: "end-state",
        details: expect.objectContaining({ horizontal: 240, samples: 3 }),
      }),
    );
    controller.begin();
    const element = new FakeElement();
    element.localName = "private-content-widget";
    send([element]);
    expect(controller.end()).toBeNull();
    const entries = controller.drainDiagnostics();
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "sample",
        details: expect.objectContaining({ reason: "custom-element" }),
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("private-content-widget");
  });

  it("bounds buffered samples and expires without a polling main process", () => {
    const { controller, send, advance } = setup();
    for (let i = 0; i < 500; i += 1) send();
    expect(controller.drainDiagnostics()).toHaveLength(100);
    advance(120_000);
    send();
    expect(controller.drainDiagnostics()).toEqual([]);
  });
});
