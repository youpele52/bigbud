import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let zoomFactor = 1;
const send = vi.fn();

vi.mock("electron", () => ({
  ipcRenderer: { send: (...args: unknown[]) => send(...args) },
  webFrame: { getZoomFactor: () => zoomFactor },
}));

import { createWindowZoomObserver } from "./windowZoom.preload";

describe("createWindowZoomObserver", () => {
  beforeEach(() => {
    zoomFactor = 1;
    send.mockClear();
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a zoom change to the main process and to listeners once", () => {
    const observer = createWindowZoomObserver("zoom-changed");
    const listener = vi.fn();
    observer.onWindowZoomFactorChange(listener);

    window.dispatchEvent(new Event("resize"));
    expect(send).not.toHaveBeenCalled();

    zoomFactor = 1.2;
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("zoom-changed");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(1.2);
    expect(observer.getWindowZoomFactor()).toBe(1.2);
  });

  it("stops notifying a listener after it unsubscribes", () => {
    const observer = createWindowZoomObserver("zoom-changed");
    const listener = vi.fn();
    observer.onWindowZoomFactorChange(listener)();

    zoomFactor = 0.8;
    window.dispatchEvent(new Event("resize"));
    expect(listener).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
