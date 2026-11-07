import type { DesktopConnectivitySignal } from "@bigbud/contracts/server/ipc.desktop.ts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDayStore } from "./useLocalDay";

const originalTimezone = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  return original;
});

afterAll(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

let browser: EventTarget;
let documentEvents: EventTarget & { visibilityState: string };
let desktopSignal: (signal: DesktopConnectivitySignal) => void;
let unsubscribeDesktop: ReturnType<typeof vi.fn>;
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 5, 23, 59, 59));
  browser = new EventTarget();
  documentEvents = Object.assign(new EventTarget(), { visibilityState: "visible" });
  unsubscribeDesktop = vi.fn();
  vi.stubGlobal(
    "window",
    Object.assign(browser, {
      desktopBridge: {
        onConnectivitySignal: (listener: typeof desktopSignal) => {
          desktopSignal = listener;
          return unsubscribeDesktop;
        },
      },
    }),
  );
  vi.stubGlobal("document", documentEvents);
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function subscribe(store: ReturnType<typeof createLocalDayStore>, listener = vi.fn()) {
  const stop = store.subscribe(listener);
  cleanups.push(stop);
  return { listener, stop };
}

describe("shared local-day clock", () => {
  it("uses one timer for all labels, emits only at midnight, and stops on last unsubscribe", () => {
    const store = createLocalDayStore();
    const first = subscribe(store);
    const second = subscribe(store);
    expect(vi.getTimerCount()).toBe(1);
    browser.dispatchEvent(new Event("focus"));
    expect(first.listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(store.snapshot()).toBe(new Date(2026, 6, 6).getTime());
    expect(first.listener).toHaveBeenCalledTimes(1);
    expect(second.listener).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    first.stop();
    expect(vi.getTimerCount()).toBe(1);
    second.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(unsubscribeDesktop).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 6, 7));
    browser.dispatchEvent(new Event("focus"));
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["focus", "pageshow", "visible", "resume", "unlock-screen"])(
    "catches up after sleep via %s and schedules the next local midnight",
    (trigger) => {
      const store = createLocalDayStore();
      const { listener } = subscribe(store);
      vi.setSystemTime(new Date(2027, 0, 1, 23, 59, 59));
      if (trigger === "visible") documentEvents.dispatchEvent(new Event("visibilitychange"));
      else if (trigger === "resume" || trigger === "unlock-screen") {
        desktopSignal({ kind: trigger, sequence: 1 } as DesktopConnectivitySignal);
      } else browser.dispatchEvent(new Event(trigger));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(store.snapshot()).toBe(new Date(2027, 0, 1).getTime());
      vi.advanceTimersByTime(1_000);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(store.snapshot()).toBe(new Date(2027, 0, 2).getTime());
    },
  );

  it("ignores hidden visibility events and refreshes on becoming visible", () => {
    const store = createLocalDayStore();
    const { listener } = subscribe(store);
    vi.setSystemTime(new Date(2026, 6, 6, 12));
    documentEvents.visibilityState = "hidden";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(listener).not.toHaveBeenCalled();
    documentEvents.visibilityState = "visible";
    documentEvents.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it.each([
    [new Date(2026, 2, 8), 23],
    [new Date(2026, 10, 1), 25],
  ])("schedules calendar midnight across DST (%s, %s hours)", (start, hours) => {
    vi.setSystemTime(start);
    const store = createLocalDayStore();
    const { listener } = subscribe(store);
    vi.advanceTimersByTime(hours * 60 * 60 * 1_000 - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(new Date(store.snapshot()).getHours()).toBe(0);
  });

  it("reads the current day when no subscribers have kept the clock running", () => {
    const store = createLocalDayStore();
    vi.setSystemTime(new Date(2026, 6, 8, 12));
    expect(store.snapshot()).toBe(new Date(2026, 6, 8).getTime());
    subscribe(store);
    expect(vi.getTimerCount()).toBe(1);
  });
});
