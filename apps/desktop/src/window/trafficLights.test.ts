import { describe, expect, it } from "vitest";

import { bindTrafficLightsToZoom, trafficLightPositionForZoom } from "./trafficLights";

describe("trafficLightPositionForZoom", () => {
  it("centres the traffic lights in the 52px title bar at each zoom", () => {
    expect(trafficLightPositionForZoom(1)).toEqual({ x: 16, y: 19 });
    // Zoomed in, the title bar is taller, so the buttons move down with its centre.
    expect(trafficLightPositionForZoom(1.5)).toEqual({ x: 16, y: 32 });
    // Zoomed out, the title bar is shorter, so they move up.
    expect(trafficLightPositionForZoom(0.75)).toEqual({ x: 16, y: 13 });
  });

  it("never moves them off the window for extreme or invalid zoom factors", () => {
    expect(trafficLightPositionForZoom(0.01)).toEqual({ x: 16, y: 0 });
    expect(trafficLightPositionForZoom(Number.NaN)).toEqual({ x: 16, y: 19 });
    expect(trafficLightPositionForZoom(100).y).toBe(trafficLightPositionForZoom(5).y);
  });
});

const fakeWindow = (zoomFactor: { value: number }) => {
  const ipcListeners = new Map<string, () => void>();
  const loadListeners: Array<() => void> = [];
  const window = {
    destroyed: false,
    positions: [] as Array<{ x: number; y: number }>,
    isDestroyed: () => window.destroyed,
    setWindowButtonPosition: (position: { x: number; y: number }) =>
      void window.positions.push(position),
    webContents: {
      getZoomFactor: () => zoomFactor.value,
      on: (_event: "did-finish-load", listener: () => void) => void loadListeners.push(listener),
      ipc: {
        on: (channel: string, listener: () => void) => void ipcListeners.set(channel, listener),
      },
    },
  };
  return { window, ipcListeners, loadListeners };
};

describe("bindTrafficLightsToZoom", () => {
  it("moves the buttons on load and on each zoom change, reading the window's own zoom", () => {
    const zoom = { value: 1.5 };
    const { window, ipcListeners, loadListeners } = fakeWindow(zoom);
    bindTrafficLightsToZoom(window, "zoom-changed", "darwin");

    loadListeners[0]!();
    zoom.value = 0.75;
    ipcListeners.get("zoom-changed")!();
    expect(window.positions).toEqual([
      { x: 16, y: 32 },
      { x: 16, y: 13 },
    ]);

    window.destroyed = true;
    ipcListeners.get("zoom-changed")!();
    expect(window.positions).toHaveLength(2);
  });

  it("does nothing outside macOS", () => {
    const { window, ipcListeners, loadListeners } = fakeWindow({ value: 2 });
    bindTrafficLightsToZoom(window, "zoom-changed", "win32");
    expect(ipcListeners.size).toBe(0);
    expect(loadListeners).toHaveLength(0);
  });
});
