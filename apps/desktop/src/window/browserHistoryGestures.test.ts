import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents, WebSource } from "electron";
import { describe, expect, it, vi } from "vitest";
import { bindBrowserHistoryGestures } from "./browserHistoryGestures";

function setup(platform: NodeJS.Platform = "darwin") {
  let time = 0;
  const owner = { isDestroyed: vi.fn(() => false), isFocused: vi.fn(() => true) };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    executeJavaScriptInIsolatedWorld: vi.fn(
      async (_worldId: number, _scripts: WebSource[]): Promise<unknown> => undefined,
    ),
  });
  bindBrowserHistoryGestures(
    owner as unknown as BrowserWindow,
    contents as unknown as WebContents,
    platform,
    () => time,
  );
  const scripts = () =>
    contents.executeJavaScriptInIsolatedWorld.mock.calls.map(
      (call) => (call as unknown as [number, { code: string }[]])[1][0]!.code,
    );
  const input = (type: string) => {
    // Chromium emits scroll begin after acknowledging the first wheel event.
    if (type === "gestureScrollBegin") contents.emit("input-event", {}, { type: "mouseWheel" });
    contents.emit("input-event", {}, { type });
  };
  const advance = (ms = 1300) => {
    time += ms;
  };
  return { owner, contents, scripts, input, advance };
}

describe("native browser history gesture binding", () => {
  it("uses the active owner, not guest keyboard focus, and rejects inactive owners", async () => {
    const { owner, contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    expect(contents.isFocused()).toBe(false);
    input("gestureScrollBegin");
    expect(scripts().at(-1)).toContain("?.begin()");
    owner.isFocused.mockReturnValue(false);
    input("gestureScrollEnd");
    expect(scripts().at(-1)).toContain("?.cancel()");
    advance();
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    owner.isFocused.mockReturnValue(true);
    owner.isDestroyed.mockReturnValue(true);
    advance();
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
  });
  it.each(["win32", "linux"] as const)("does nothing on %s", (platform) => {
    const { contents } = setup(platform);
    expect(contents.eventNames()).toEqual([]);
  });

  it("installs in a private world, never in the app renderer or via a page-visible bridge", async () => {
    const { contents, scripts, input } = setup();
    input("gestureScrollBegin");
    expect(scripts()).toEqual([]);
    contents.emit("dom-ready");
    await Promise.resolve();
    expect(contents.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[0]).toBe(1004);
    expect(scripts()[0]).toContain("isTrusted");
    expect(scripts()[0]).not.toMatch(/ipcRenderer|contextBridge|require\(/);
    input("mouseWheel");
    expect(scripts()).toHaveLength(1);
  });

  it("commits once per native phase and ignores duplicate begins and momentum", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    input("gestureScrollBegin");
    input("gestureFlingStart");
    input("gestureScrollBegin");
    input("gestureScrollUpdate");
    input("gestureScrollEnd");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    expect(scripts().filter((code) => code.includes("?.end()"))).toHaveLength(1);
    advance();
    input("gestureScrollBegin");
    input("gestureScrollEnd");
    expect(scripts().filter((code) => code.includes("?.end()"))).toHaveLength(2);
  });

  it("does not rearm momentum in the destination document", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    input("gestureFlingStart");
    contents.emit("did-start-navigation", {}, "https://site.example/previous", false, true);
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    advance();
    input("gestureFlingCancel");
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(2);
  });

  it("cancels if the owner loses focus and waits for a new document after navigation or a crash", async () => {
    const { owner, contents, scripts, input } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    owner.isFocused.mockReturnValue(false);
    input("gestureScrollEnd");
    expect(scripts().at(-1)).toContain("?.cancel()");
    owner.isFocused.mockReturnValue(true);
    contents.emit("did-start-navigation", {}, "https://site.example/next", false, true);
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    contents.emit("dom-ready");
    await Promise.resolve();
    contents.emit("render-process-gone");
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
  });

  it("fails closed on isolated-world installation failure", async () => {
    const { contents, scripts, input } = setup();
    contents.executeJavaScriptInIsolatedWorld.mockRejectedValueOnce(
      new Error("renderer restarted"),
    );
    contents.emit("dom-ready");
    await Promise.resolve();
    await Promise.resolve();
    input("gestureScrollBegin");
    input("gestureScrollEnd");
    expect(scripts()).toHaveLength(1);
  });

  it("cancels pinch/zoom or keyboard/mouse interruptions instead of turning them into history", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    input("gesturePinchBegin");
    expect(scripts().at(-1)).toContain("?.cancel()");
    input("gestureScrollEnd");
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    advance();
    input("gesturePinchEnd");
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(2);
    for (const type of ["rawKeyDown", "keyDown", "mouseDown"]) {
      input(type);
      expect(scripts().at(-1)).toContain("?.cancel()");
    }
  });

  it("rejects macOS momentum that starts a second scroll phase without any fling event", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    input("gestureScrollEnd");
    contents.emit("did-start-navigation", {}, "https://site.example/previous", false, true);
    contents.emit("dom-ready");
    await Promise.resolve();
    advance(16);
    input("gestureScrollBegin");
    for (let index = 0; index < 100; index += 1) {
      advance(16);
      input("mouseWheel");
    }
    input("gestureScrollEnd");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    expect(scripts().filter((code) => code.includes("?.end()"))).toHaveLength(1);
    advance(300);
    input("gestureScrollBegin");
    input("gestureScrollEnd");
    expect(scripts().filter((code) => code.includes("?.end()"))).toHaveLength(2);
  });

  it("keeps the cooldown when the page navigated mid-phase and momentum continues", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    contents.emit("did-start-navigation", {}, "https://site.example/previous", false, true);
    contents.emit("dom-ready");
    await Promise.resolve();
    advance(300);
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(1);
    advance(1000);
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(2);
  });

  it("does not impose the history cooldown when the page declined navigation", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(null);
    input("gestureScrollEnd");
    await Promise.resolve();
    advance(300);
    input("gestureScrollBegin");
    expect(scripts().filter((code) => code.includes("?.begin()"))).toHaveLength(2);
  });

  it("tags commands so queued gestures cannot act on a replacement document", async () => {
    const { contents, scripts, input, advance } = setup();
    contents.emit("dom-ready");
    await Promise.resolve();
    input("gestureScrollBegin");
    expect(scripts().at(-1)).toContain("generation === 1");
    contents.emit("did-start-navigation", {}, "https://site.example/replacement", false, true);
    contents.emit("dom-ready");
    await Promise.resolve();
    advance();
    input("gestureScrollBegin");
    expect(scripts().at(-1)).toContain("generation === 3");
  });

  it("ignores an installation that resolves after another document starts loading", async () => {
    const { contents, scripts, input } = setup();
    let complete!: (value: undefined) => void;
    contents.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    contents.emit("dom-ready");
    contents.emit("did-start-navigation", {}, "https://site.example/other", false, true);
    complete(undefined);
    await Promise.resolve();
    input("gestureScrollBegin");
    input("gestureScrollEnd");
    expect(scripts()).toHaveLength(1);
  });
});
