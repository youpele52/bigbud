import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("./Sidebar.itutu.actions", () => ({
  ITUTU_SNOOZE_PRESETS: [{ minutes: 10, label: "10 minutes" }],
  moveThreadsToState: vi.fn(),
  snoozeThread: vi.fn(),
}));

import { buildItutuMoveMenuItem, runItutuMenuAction } from "./Sidebar.itutu.menu";
import { parseSnoozeDuration, useItutuSnoozePickerStore } from "./Sidebar.itutu.snoozePicker";

describe("parseSnoozeDuration", () => {
  it("reads minutes and hours within 2 minutes to 24 hours", () => {
    expect(parseSnoozeDuration("45")).toEqual({ ok: true, minutes: 45 });
    expect(parseSnoozeDuration(" 90m ")).toEqual({ ok: true, minutes: 90 });
    expect(parseSnoozeDuration("3h")).toEqual({ ok: true, minutes: 180 });
    expect(parseSnoozeDuration("1h 30m")).toEqual({ ok: true, minutes: 90 });
    expect(parseSnoozeDuration("2 hours 5 mins")).toEqual({ ok: true, minutes: 125 });
    expect(parseSnoozeDuration("2")).toEqual({ ok: true, minutes: 2 });
    expect(parseSnoozeDuration("24h")).toEqual({ ok: true, minutes: 1440 });
  });

  it("rejects empty, malformed, and out-of-range durations", () => {
    for (const input of ["", "soon", "1.5h", "-5", "h", "m"]) {
      expect(parseSnoozeDuration(input).ok).toBe(false);
    }
    expect(parseSnoozeDuration("1")).toEqual({
      ok: false,
      error: "Snooze for 2 minutes to 24 hours.",
    });
    expect(parseSnoozeDuration("24h 1m").ok).toBe(false);
  });
});

describe("custom snooze in Move to", () => {
  const threadId = ThreadId.makeUnsafe("thread-picker");

  it("offers the picker for one thread only, after the presets", () => {
    const single = buildItutuMoveMenuItem({
      state: "present",
      revision: 0,
      changedAt: null,
      snooze: null,
    });
    expect(single.children?.at(-1)).toMatchObject({ label: "Snooze for…" });
    expect(
      buildItutuMoveMenuItem(null).children?.some((item) => item.label === "Snooze for…"),
    ).toBe(false);
  });

  it("opens the picker for the clicked thread", async () => {
    const id = buildItutuMoveMenuItem(undefined).children!.at(-1)!.id;
    expect(await runItutuMenuAction(id, [threadId])).toBe(true);
    expect(useItutuSnoozePickerStore.getState().threadId).toBe(threadId);
    useItutuSnoozePickerStore.getState().close();
    expect(await runItutuMenuAction(id, [threadId, ThreadId.makeUnsafe("other")])).toBe(false);
    expect(useItutuSnoozePickerStore.getState().threadId).toBe(null);
  });
});
