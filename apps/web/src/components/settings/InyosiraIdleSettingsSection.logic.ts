import {
  INYOSIRA_IDLE_TIMEOUT_MAX_MINUTES,
  INYOSIRA_IDLE_TIMEOUT_MIN_MINUTES,
  INYOSIRA_OLDER_THREADS_MAX_DAYS,
  INYOSIRA_OLDER_THREADS_MIN_DAYS,
} from "@bigbud/contracts/settings";

export interface WholeNumberBounds {
  readonly min: number;
  readonly max: number;
}

export const IDLE_TIMEOUT_MINUTES_BOUNDS: WholeNumberBounds = {
  min: INYOSIRA_IDLE_TIMEOUT_MIN_MINUTES,
  max: INYOSIRA_IDLE_TIMEOUT_MAX_MINUTES,
};

export const OLDER_THREADS_DAYS_BOUNDS: WholeNumberBounds = {
  min: INYOSIRA_OLDER_THREADS_MIN_DAYS,
  max: INYOSIRA_OLDER_THREADS_MAX_DAYS,
};

/** The whole number to save for a typed draft, or null to restore the current value. */
export function resolveWholeNumberDraft(
  draft: string,
  current: number,
  bounds: WholeNumberBounds,
): number | null {
  const text = draft.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (value < bounds.min || value > bounds.max) return null;
  return value === current ? null : value;
}

export const INYOSIRA_IDLE_DESTINATION_LABELS = { done: "Done", later: "Later" } as const;
