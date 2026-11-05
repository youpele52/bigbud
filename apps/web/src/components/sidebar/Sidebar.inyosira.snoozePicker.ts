import type { ThreadId } from "@bigbud/contracts";
import {
  THREAD_SNOOZE_MAX_MINUTES,
  THREAD_SNOOZE_MIN_MINUTES,
} from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { create } from "zustand";

/** Which thread the custom snooze picker is open for, if any. */
export const useInyosiraSnoozePickerStore = create<{
  readonly threadId: ThreadId | null;
  readonly open: (threadId: ThreadId) => void;
  readonly close: () => void;
}>((set) => ({
  threadId: null,
  open: (threadId) => set({ threadId }),
  close: () => set({ threadId: null }),
}));

export type SnoozeDurationParse =
  | { readonly ok: true; readonly minutes: number }
  | { readonly ok: false; readonly error: string };

const DURATION_PATTERN = /^(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/i;

/**
 * Parses "45", "90m", "3h", or "1h 30m" into whole minutes within the snooze bounds. A bare
 * number means minutes.
 */
export function parseSnoozeDuration(input: string): SnoozeDurationParse {
  const text = input.trim();
  if (text === "") return { ok: false, error: "Enter a duration." };
  let minutes: number;
  if (/^\d+$/.test(text)) {
    minutes = Number(text);
  } else {
    const match = DURATION_PATTERN.exec(text);
    if (!match || (match[1] === undefined && match[2] === undefined)) {
      return { ok: false, error: "Use minutes or hours, like 45, 90m, 3h, or 1h 30m." };
    }
    minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  }
  if (minutes < THREAD_SNOOZE_MIN_MINUTES || minutes > THREAD_SNOOZE_MAX_MINUTES) {
    return { ok: false, error: "Snooze for 2 minutes to 24 hours." };
  }
  return { ok: true, minutes };
}

export const formatSnoozeWakeTime = (date: Date) =>
  date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
