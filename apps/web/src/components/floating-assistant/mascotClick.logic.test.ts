import { afterEach, describe, expect, it, vi } from "vitest";

import { createMascotClickHandler, MASCOT_SINGLE_CLICK_DELAY_MS } from "./mascotClick.logic";

describe("mascot click handler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the compact chat after a single-click delay", () => {
    vi.useFakeTimers();
    const onOpenChat = vi.fn();
    const onOpenMain = vi.fn();
    const handler = createMascotClickHandler({ onOpenChat, onOpenMain });

    handler.handleClick(1);

    vi.advanceTimersByTime(MASCOT_SINGLE_CLICK_DELAY_MS - 1);
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(onOpenMain).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(onOpenMain).not.toHaveBeenCalled();
  });

  it("opens bigbud instead of the compact chat on double click", () => {
    vi.useFakeTimers();
    const onOpenChat = vi.fn();
    const onOpenMain = vi.fn();
    const handler = createMascotClickHandler({ onOpenChat, onOpenMain });

    handler.handleClick(1);
    handler.handleClick(2);
    vi.advanceTimersByTime(MASCOT_SINGLE_CLICK_DELAY_MS);

    expect(onOpenChat).not.toHaveBeenCalled();
    expect(onOpenMain).toHaveBeenCalledOnce();
  });

  it("cancels a pending single-click action", () => {
    vi.useFakeTimers();
    const onOpenChat = vi.fn();
    const handler = createMascotClickHandler({ onOpenChat, onOpenMain: vi.fn() });

    handler.handleClick(1);
    handler.cancel();
    vi.advanceTimersByTime(MASCOT_SINGLE_CLICK_DELAY_MS);

    expect(onOpenChat).not.toHaveBeenCalled();
  });
});
