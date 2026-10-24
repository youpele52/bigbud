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
    scrollLeft = 0;
    computed: Record<string, string> = {};
    matches() {
      return false;
    }
  }
  const document: { scrollingElement: FakeElement | null } = { scrollingElement: null };
  const navigations: string[] = [];
  const context = {
    performance: { now: () => time },
    window: {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "wheel") wheel = listener;
      },
      removeEventListener: () => {},
    },
    Element: FakeElement,
    document,
    getComputedStyle: (element: FakeElement) => ({
      overscrollBehaviorX: "auto",
      overflowX: "visible",
      direction: "ltr",
      ...element.computed,
    }),
    queueMicrotask: (callback: () => void) => callback(),
    history: { back: () => navigations.push("back"), forward: () => navigations.push("forward") },
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
  const send = (path: FakeElement[] = [], deltaX = -80) => {
    time += 20;
    wheel?.({
      isTrusted: true,
      deltaX,
      deltaY: 0,
      deltaMode: 0,
      buttons: 0,
      composedPath: () => path,
    });
  };
  const scroller = (scrollLeft: number, computed: Record<string, string> = {}) =>
    Object.assign(new FakeElement(), {
      scrollWidth: 400,
      scrollLeft,
      computed: { overflowX: "auto", ...computed },
    });
  return {
    controller,
    send,
    FakeElement,
    document,
    navigations,
    scroller,
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
    const { controller, send, FakeElement, scroller } = setup();
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
    send([element, scroller(200)]);
    expect(controller.end()).toBeNull();
    const entries = controller.drainDiagnostics();
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "sample",
        details: expect.objectContaining({ reason: "horizontal-scroller" }),
      }),
    );
    expect(JSON.stringify(entries)).not.toContain("private-content-widget");
  });

  it("navigates once mid-gesture and reports the commit at the native phase end", () => {
    const { controller, send, navigations, FakeElement } = setup(false);
    const widget = new FakeElement();
    widget.localName = "site-app-root";
    controller.begin();
    for (let index = 0; index < 8; index += 1) send([widget]);
    expect(navigations).toEqual(["back"]);
    expect(controller.end()).toBe("back");
    expect(controller.end()).toBeNull();
  });

  it("lets scrollers at the swipe edge through, like native overscroll navigation", () => {
    const { controller, send, navigations, scroller } = setup(false);
    const cases = [
      { element: scroller(0), deltaX: -80, navigates: true },
      { element: scroller(300), deltaX: 80, navigates: true },
      { element: scroller(150), deltaX: -80, navigates: false },
      { element: scroller(0), deltaX: 80, navigates: false },
      { element: scroller(0, { direction: "rtl" }), deltaX: -80, navigates: false },
      { element: scroller(-300, { direction: "rtl" }), deltaX: -80, navigates: true },
      { element: scroller(0, { overscrollBehaviorX: "contain" }), deltaX: -80, navigates: false },
    ];
    for (const { element, deltaX, navigates } of cases) {
      navigations.length = 0;
      controller.begin();
      for (let index = 0; index < 3; index += 1) send([element], deltaX);
      controller.end();
      expect(navigations.length > 0, JSON.stringify({ deltaX, ...element })).toBe(navigates);
    }
  });

  it("honors a root overscroll opt-out but not one on a vertical-only pane", () => {
    const { controller, send, navigations, document, FakeElement } = setup(false);
    const pane = Object.assign(new FakeElement(), {
      computed: { overflowX: "auto", overscrollBehaviorX: "contain" },
    });
    controller.begin();
    for (let index = 0; index < 3; index += 1) send([pane]);
    expect(navigations).toEqual(["back"]);
    const root = Object.assign(new FakeElement(), { computed: { overscrollBehaviorX: "none" } });
    document.scrollingElement = root;
    controller.begin();
    for (let index = 0; index < 3; index += 1) send([pane, root]);
    expect(navigations).toEqual(["back"]);
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
