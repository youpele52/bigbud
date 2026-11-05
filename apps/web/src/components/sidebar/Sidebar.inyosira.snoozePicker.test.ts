import { ThreadId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./Sidebar.inyosira.actions", () => ({
  INYOSIRA_SNOOZE_PRESETS: [{ minutes: 10, label: "10 mins" }],
  moveThreadsToState: vi.fn(),
  snoozeThread: vi.fn(),
}));

import { moveThreadsToState, snoozeThread } from "./Sidebar.inyosira.actions";
import {
  buildInyosiraMoveMenuItem,
  buildInyosiraSnoozeMenuItem,
  runInyosiraMenuAction,
} from "./Sidebar.inyosira.menu";
import { parseSnoozeDuration, useInyosiraSnoozePickerStore } from "./Sidebar.inyosira.snoozePicker";

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

describe("Snooze submenu", () => {
  const threadId = ThreadId.makeUnsafe("thread-picker");

  beforeEach(() => {
    vi.clearAllMocks();
    useInyosiraSnoozePickerStore.getState().close();
  });

  it("groups presets and the custom picker under Snooze, not Move to", () => {
    const snooze = buildInyosiraSnoozeMenuItem(undefined);
    expect(snooze.label).toBe("Snooze for…");
    expect(snooze.children?.map((item) => item.label)).toEqual(["10 mins", "Custom duration…"]);
    expect(snooze.children?.some((item) => item.separator)).toBe(false);
    for (const organization of [undefined, null]) {
      expect(buildInyosiraMoveMenuItem(organization).children?.map((item) => item.label)).toEqual([
        "Present",
        "Needs you",
        "Later",
        "Done",
      ]);
    }
  });

  it.each([false, true])("keeps menu IDs unique across all levels (snoozed=%s)", (snoozed) => {
    const organization = {
      state: "later" as const,
      revision: 1,
      changedAt: null,
      snooze: snoozed ? { id: "snooze-1", until: "2026-11-03T12:00:00.000Z" } : null,
    };
    const move = buildInyosiraMoveMenuItem(organization);
    const direct = buildInyosiraSnoozeMenuItem(organization);
    // Native menus deduplicate clickable IDs across the root and submenu levels.
    const ids = [move, ...(move.children ?? []), direct, ...(direct.children ?? [])]
      .filter((item) => !item.separator)
      .map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not dispatch the submenu parent as an action", async () => {
    expect(await runInyosiraMenuAction(buildInyosiraSnoozeMenuItem(undefined).id, [threadId])).toBe(
      false,
    );
    expect(useInyosiraSnoozePickerStore.getState().threadId).toBeNull();
    expect(snoozeThread).not.toHaveBeenCalled();
  });

  it("keeps wake time, cancellation, and rescheduling under Snooze", async () => {
    const menu = buildInyosiraSnoozeMenuItem({
      state: "later",
      revision: 1,
      changedAt: null,
      snooze: { id: "snooze-1", until: "2026-11-03T12:00:00.000Z" },
    });
    expect(menu.label).toBe("Snooze for…");
    expect(menu.children?.[0]).toMatchObject({
      label: expect.stringContaining("Snoozed until"),
      disabled: true,
    });
    expect(menu.children?.[1]?.label).toBe("Cancel snooze");
    expect(menu.children?.[2]).toMatchObject({ separator: true });
    expect(menu.children?.slice(3).map((item) => item.label)).toEqual([
      "10 mins",
      "Custom duration…",
    ]);
    const cancel = menu.children![1]!;
    expect(await runInyosiraMenuAction(cancel.id, [threadId])).toBe(true);
    expect(moveThreadsToState).toHaveBeenCalledWith([threadId], "present");
  });

  it("runs a preset only for a single thread", async () => {
    const preset = buildInyosiraSnoozeMenuItem(undefined).children![0]!;
    expect(await runInyosiraMenuAction(preset.id, [threadId])).toBe(true);
    expect(snoozeThread).toHaveBeenCalledWith(threadId, 10);
    vi.clearAllMocks();
    expect(await runInyosiraMenuAction(preset.id, [])).toBe(false);
    expect(await runInyosiraMenuAction(preset.id, [threadId, threadId])).toBe(false);
    expect(snoozeThread).not.toHaveBeenCalled();
  });

  it("opens the picker for the clicked thread", async () => {
    const id = buildInyosiraSnoozeMenuItem(undefined).children!.at(-1)!.id;
    expect(await runInyosiraMenuAction(id, [threadId])).toBe(true);
    expect(useInyosiraSnoozePickerStore.getState().threadId).toBe(threadId);
    useInyosiraSnoozePickerStore.getState().close();
    expect(await runInyosiraMenuAction(id, [])).toBe(false);
    expect(await runInyosiraMenuAction(id, [threadId, ThreadId.makeUnsafe("other")])).toBe(false);
    expect(useInyosiraSnoozePickerStore.getState().threadId).toBe(null);
  });
});
