import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FILES_DRAWER_CLOSE_DELAY,
  FILES_DRAWER_OPEN_DELAY,
  FilesDrawerController,
} from "./FilesPanel.drawer.controller";

describe("FilesDrawerController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const changed = vi.fn();
    const drawer = new FilesDrawerController(changed);
    drawer.setActive(true);
    return { drawer, changed };
  }

  it("opens only after sustained handle hover, not a brief pass", () => {
    const { drawer, changed } = setup();
    drawer.enterHandle();
    vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY - 1);
    expect(changed).not.toHaveBeenCalled();
    drawer.setTrigger("header", false);
    vi.advanceTimersByTime(1000);
    expect(changed).not.toHaveBeenCalled();
    drawer.enterHandle();
    vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY);
    expect(changed).toHaveBeenLastCalledWith("hover");
  });

  it("closes after the leave grace period and cancels on return", () => {
    const { drawer, changed } = setup();
    drawer.enterHandle();
    vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY);
    drawer.setTrigger("header", false);
    vi.advanceTimersByTime(FILES_DRAWER_CLOSE_DELAY - 1);
    expect(changed).toHaveBeenCalledOnce();
    drawer.setActivity("pointer", true);
    vi.advanceTimersByTime(FILES_DRAWER_CLOSE_DELAY);
    expect(changed).toHaveBeenCalledOnce();
    drawer.setActivity("pointer", false);
    vi.advanceTimersByTime(FILES_DRAWER_CLOSE_DELAY);
    expect(changed).toHaveBeenLastCalledWith("closed");
  });

  it.each(["focus", "menu", "interaction", "drag"] as const)(
    "holds the drawer for %s, then starts a fresh close grace period",
    (activity) => {
      const { drawer, changed } = setup();
      drawer.enterHandle();
      vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY);
      drawer.setTrigger("header", false);
      vi.advanceTimersByTime(500);
      drawer.setActivity(activity, true);
      vi.advanceTimersByTime(2000);
      expect(changed).toHaveBeenCalledOnce();
      drawer.setActivity(activity, false);
      vi.advanceTimersByTime(FILES_DRAWER_CLOSE_DELAY - 1);
      expect(changed).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1);
      expect(changed).toHaveBeenLastCalledWith("closed");
    },
  );

  it("promotes a hover-open drawer to explicit-open and keeps it until dismissed", () => {
    const { drawer, changed } = setup();
    drawer.enterHandle();
    vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY);
    drawer.open();
    drawer.setTrigger("header", false);
    vi.advanceTimersByTime(10_000);
    expect(changed).toHaveBeenLastCalledWith("open");
    drawer.dismiss();
    expect(changed).toHaveBeenLastCalledWith("closed");
  });

  it("pins across preview boundaries and unpins to explicit-open", () => {
    const { drawer, changed } = setup();
    drawer.open();
    drawer.togglePin();
    drawer.setActivity("pointer", false);
    vi.advanceTimersByTime(10_000);
    expect(changed).toHaveBeenLastCalledWith("pinned");
    drawer.setActive(false);
    drawer.setActive(true);
    expect(changed).toHaveBeenLastCalledWith("pinned");
    drawer.togglePin();
    expect(changed).toHaveBeenLastCalledWith("open");
  });

  it("toggles a pinned tree closed, clears its pin, and reopens as an explicit overlay", () => {
    const { drawer, changed } = setup();
    expect(drawer.toggle()).toBe(true);
    drawer.togglePin();
    expect(changed).toHaveBeenLastCalledWith("pinned");
    expect(drawer.toggle()).toBe(false);
    expect(changed).toHaveBeenLastCalledWith("closed");
    expect(drawer.toggle()).toBe(true);
    expect(changed).toHaveBeenLastCalledWith("open");
  });

  it.each(["edge", "header"] as const)(
    "suppresses %s hover after explicit close until leaving and reentering",
    (source) => {
      const { drawer, changed } = setup();
      const enter = () => drawer.observeTriggers(source === "edge", source === "header");
      enter();
      vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY);
      expect(changed).toHaveBeenLastCalledWith("hover");
      // A toggle click closes even when hover already revealed the tree.
      drawer.toggle();
      expect(changed).toHaveBeenLastCalledWith("closed");
      drawer.setActivity("pointer", false); // drawer disappearance is not trigger exit
      enter();
      vi.advanceTimersByTime(2000);
      expect(changed).toHaveBeenCalledTimes(2);
      drawer.observeTriggers(false, false);
      enter();
      vi.advanceTimersByTime(FILES_DRAWER_OPEN_DELAY - 1);
      expect(changed).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(changed).toHaveBeenLastCalledWith("hover");
      drawer.dismiss(); // Escape uses the same suppression rule.
      enter();
      vi.advanceTimersByTime(2000);
      expect(changed).toHaveBeenLastCalledWith("closed");
      drawer.open(); // explicit keyboard opening never waits for pointer rearming
      expect(changed).toHaveBeenLastCalledWith("open");
    },
  );

  it("clears transient state and timers when preview or workspace changes", () => {
    const { drawer, changed } = setup();
    drawer.enterHandle();
    drawer.setActive(false);
    vi.advanceTimersByTime(2000);
    expect(changed).not.toHaveBeenCalled();
    drawer.enterHandle();
    drawer.open();
    vi.advanceTimersByTime(2000);
    expect(changed).not.toHaveBeenCalled();
    drawer.setActive(true);
    drawer.open();
    drawer.setActive(true);
    expect(changed).toHaveBeenLastCalledWith("closed");
  });

  it("cancels pending work on disposal", () => {
    const { drawer, changed } = setup();
    drawer.enterHandle();
    drawer.dispose();
    vi.advanceTimersByTime(2000);
    expect(changed).not.toHaveBeenCalled();
  });
});
