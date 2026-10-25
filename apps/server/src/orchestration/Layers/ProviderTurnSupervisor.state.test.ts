import { describe, expect, it } from "vitest";

import { readSleepContinuationEnabled } from "./ProviderTurnSupervisor.state.ts";

describe("readSleepContinuationEnabled (BIGBUD_SLEEP_CONTINUATION)", () => {
  it("is on by default and for any value that does not turn it off", () => {
    expect(readSleepContinuationEnabled({})).toBe(true);
    for (const value of ["", "1", "true", "on", "yes", "garbage"]) {
      expect(readSleepContinuationEnabled({ BIGBUD_SLEEP_CONTINUATION: value })).toBe(true);
    }
  });

  it("turns off for 0, false or off, ignoring case and surrounding space", () => {
    for (const value of ["0", "false", "off", " FALSE ", "Off", "\t0\n"]) {
      expect(readSleepContinuationEnabled({ BIGBUD_SLEEP_CONTINUATION: value })).toBe(false);
    }
  });
});
