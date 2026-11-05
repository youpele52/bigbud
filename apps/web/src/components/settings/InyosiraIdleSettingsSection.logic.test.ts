import { describe, expect, it } from "vitest";

import {
  IDLE_TIMEOUT_MINUTES_BOUNDS,
  OLDER_THREADS_DAYS_BOUNDS,
  resolveWholeNumberDraft,
} from "./InyosiraIdleSettingsSection.logic";

describe("resolveWholeNumberDraft", () => {
  it("saves idle timeouts in whole minutes from 10 minutes to 1 day", () => {
    expect(resolveWholeNumberDraft("10", 20, IDLE_TIMEOUT_MINUTES_BOUNDS)).toBe(10);
    expect(resolveWholeNumberDraft(" 45 ", 10, IDLE_TIMEOUT_MINUTES_BOUNDS)).toBe(45);
    expect(resolveWholeNumberDraft("1440", 10, IDLE_TIMEOUT_MINUTES_BOUNDS)).toBe(1440);
  });

  it("saves older-thread ages in whole days from 1 to 30", () => {
    expect(resolveWholeNumberDraft("1", 3, OLDER_THREADS_DAYS_BOUNDS)).toBe(1);
    expect(resolveWholeNumberDraft("30", 1, OLDER_THREADS_DAYS_BOUNDS)).toBe(30);
  });

  it("restores the current value for unchanged, invalid, or out-of-range drafts", () => {
    for (const draft of ["10", "", "9", "1.5", "-3", "1441", "ten"]) {
      expect(resolveWholeNumberDraft(draft, 10, IDLE_TIMEOUT_MINUTES_BOUNDS), draft).toBe(null);
    }
    for (const draft of ["1", "0", "31", "2.5"]) {
      expect(resolveWholeNumberDraft(draft, 1, OLDER_THREADS_DAYS_BOUNDS), draft).toBe(null);
    }
  });
});
