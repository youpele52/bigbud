// Ported from Orca (stablyai/orca, MIT) src/renderer/src/lib/pane-manager/pane-terminal-mouse-wheel.test.ts at be4e0719.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalTuiMouseWheelDistanceState,
  normalizeTerminalTuiMouseWheelMultiplier,
  resolveTerminalTuiMouseWheelReportCount,
} from "./terminalTuiWheel";
import { DOM_DELTA_PIXEL } from "./terminalTuiWheel.test.helpers";

describe("terminal TUI wheel report counts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes TUI wheel multipliers to the supported report range", () => {
    expect(normalizeTerminalTuiMouseWheelMultiplier(undefined)).toBe(1);
    expect(normalizeTerminalTuiMouseWheelMultiplier(0)).toBe(1);
    expect(normalizeTerminalTuiMouseWheelMultiplier(4.4)).toBe(4);
    expect(normalizeTerminalTuiMouseWheelMultiplier(20)).toBe(10);
  });

  it("keeps deliberate TUI wheel ticks precise at the one-report setting", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [0, 200, 400, 600].map(() =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([1, 1, 1, 1]);
  });

  it("scales notched TUI wheel ticks by the configured multiplier", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [0, 50, 100, 150].map(() =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 },
        5,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([5, 5, 5, 5]);
  });

  it("keeps paced 1x TUI wheel ticks precise", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [0, 80, 160, 240].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120, timeStamp },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([1, 1, 1, 1]);
  });

  it("adds a burst boost for very fast 1x TUI wheel scrolling", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [0, 16, 32, 48, 64].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120, timeStamp },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([1, 1, 3, 3, 4]);
  });

  it("uses a hotter compressed wheel distance curve for larger TUI wheel movements", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 16, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 },
        1,
        state,
        { cellHeight: 16 },
      ),
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 16 * 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 * 12 },
        1,
        state,
        { cellHeight: 16 },
      ),
    ];

    expect(reports).toEqual([1, 6]);
  });

  it("caps a single accelerated TUI wheel event before it becomes a huge jump", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = resolveTerminalTuiMouseWheelReportCount(
      { deltaY: 16 * 200, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 * 200 },
      1,
      state,
      { cellHeight: 16 },
    );

    expect(reports).toBe(6);
  });

  it("lets aggressive repeated TUI wheel events exceed the single-event cap", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [0, 16, 32, 48, 64].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        {
          deltaY: 16 * 200,
          deltaMode: DOM_DELTA_PIXEL,
          timeStamp,
          wheelDeltaY: -120 * 200,
        },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([6, 6, 8, 8, 9]);
  });

  it("does not carry burst boost into a decaying momentum tail", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [
      [200, 0],
      [200, 16],
      [200, 32],
      [80, 48],
      [20, 64],
      [5, 80],
    ].map(([rows = 0, timeStamp = 0]) =>
      resolveTerminalTuiMouseWheelReportCount(
        {
          deltaY: 16 * rows,
          deltaMode: DOM_DELTA_PIXEL,
          timeStamp,
          wheelDeltaY: -120 * rows,
        },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([6, 6, 8, 6, 6, 4]);
  });

  it("retains fractional trackpad distance until it reaches a full row", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [4, 4, 4, 4].map((deltaY) =>
      resolveTerminalTuiMouseWheelReportCount({ deltaY, deltaMode: DOM_DELTA_PIXEL }, 1, state, {
        cellHeight: 16,
      }),
    );

    expect(reports).toEqual([0, 0, 0, 1]);
  });

  it("does not burst-boost rapid trackpad-like pixel deltas", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [0, 16, 32, 48].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 4, deltaMode: DOM_DELTA_PIXEL, timeStamp },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([0, 0, 0, 1]);
  });

  it("tracks a decaying trackpad-like momentum tail with linear row distance", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [16, 20, 24, 28, 20, 12, 6, 3].map((deltaY, index) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY, deltaMode: DOM_DELTA_PIXEL, timeStamp: index * 16 },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([1, 1, 1, 2, 1, 1, 0, 1]);
  });

  it("drops pending trackpad distance on each direction change", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [16, 20, 24, -16, -20, -24, -18, -10, 6, -4].map((deltaY, index) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY, deltaMode: DOM_DELTA_PIXEL, timeStamp: index * 16 },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  });

  it("emits the full linear distance for a fast trackpad-like flick event", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [16 * 12, 16 * 12, 16 * 12].map((deltaY, index) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY, deltaMode: DOM_DELTA_PIXEL, timeStamp: index * 16 },
        1,
        state,
        { cellHeight: 16 },
      ),
    );

    expect(reports).toEqual([12, 12, 12]);
  });

  it("resets pending fractional distance when the user changes direction", () => {
    const state = createTerminalTuiMouseWheelDistanceState();

    const reports = [
      resolveTerminalTuiMouseWheelReportCount({ deltaY: 4, deltaMode: DOM_DELTA_PIXEL }, 1, state, {
        cellHeight: 16,
      }),
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: -12, deltaMode: DOM_DELTA_PIXEL },
        1,
        state,
        { cellHeight: 16 },
      ),
    ];

    expect(reports).toEqual([0, 0]);
  });
});
