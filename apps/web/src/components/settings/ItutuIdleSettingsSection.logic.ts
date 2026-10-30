import {
  ITUTU_IDLE_TIMEOUT_MAX_MINUTES,
  ITUTU_IDLE_TIMEOUT_MIN_MINUTES,
} from "@bigbud/contracts/settings";

/** The timeout to save for a typed draft, or null to restore the current value. */
export function resolveIdleTimeoutDraft(draft: string, currentMinutes: number): number | null {
  const text = draft.trim();
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  if (minutes < ITUTU_IDLE_TIMEOUT_MIN_MINUTES || minutes > ITUTU_IDLE_TIMEOUT_MAX_MINUTES) {
    return null;
  }
  return minutes === currentMinutes ? null : minutes;
}

export const ITUTU_IDLE_DESTINATION_LABELS = { done: "Done", later: "Later" } as const;
