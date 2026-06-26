import { describe, expect, it, vi } from "vitest";

import {
  createDebouncedFilePreviewRefresh,
  scheduleDelayedRefresh,
} from "./useFilePreviewRefresh.logic";

describe("scheduleDelayedRefresh", () => {
  it("invokes the refresh callback after the configured delay", () => {
    vi.useFakeTimers();
    const refreshPreview = vi.fn();

    const cancel = scheduleDelayedRefresh(refreshPreview, 150);
    expect(refreshPreview).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(refreshPreview).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refreshPreview).toHaveBeenCalledTimes(1);

    cancel();
    vi.useRealTimers();
  });
});

describe("createDebouncedFilePreviewRefresh", () => {
  it("coalesces rapid refresh requests into one delayed reload", () => {
    vi.useFakeTimers();
    const refreshPreview = vi.fn();
    const refresh = createDebouncedFilePreviewRefresh(refreshPreview, 150);

    refresh.schedule();
    refresh.schedule();
    vi.advanceTimersByTime(149);
    expect(refreshPreview).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(refreshPreview).toHaveBeenCalledTimes(1);

    refresh.cancel();
    vi.useRealTimers();
  });

  it("cancels a pending preview reload", () => {
    vi.useFakeTimers();
    const refreshPreview = vi.fn();
    const refresh = createDebouncedFilePreviewRefresh(refreshPreview, 150);

    refresh.schedule();
    refresh.cancel();
    vi.advanceTimersByTime(150);

    expect(refreshPreview).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
