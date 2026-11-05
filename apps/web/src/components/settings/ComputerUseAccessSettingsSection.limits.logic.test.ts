import { describe, expect, it } from "vitest";

import {
  formatLimitBound,
  formatLimitMinutes,
  resolveLimitCommit,
} from "./ComputerUseAccessSettingsSection.limits.logic";

const timeout = { minMs: 10_000, maxMs: 60 * 60_000 };

describe("computer-use limit editing", () => {
  it("keeps a stored sub-minute timeout when the draft is untouched", () => {
    expect(formatLimitMinutes(30_000)).toBe("0.5");
    expect(resolveLimitCommit({ draft: "0.5", valueMs: 30_000, ...timeout })).toEqual({
      kind: "unchanged",
    });
    expect(formatLimitMinutes(10_000)).toBe("0.167");
    expect(resolveLimitCommit({ draft: "0.167", valueMs: 10_000, ...timeout })).toEqual({
      kind: "unchanged",
    });
  });

  it("clamps in milliseconds so the 10 second minimum never becomes 0", () => {
    expect(resolveLimitCommit({ draft: "0", valueMs: 15 * 60_000, ...timeout })).toEqual({
      kind: "commit",
      valueMs: 10_000,
    });
    expect(resolveLimitCommit({ draft: "500", valueMs: 15 * 60_000, ...timeout })).toEqual({
      kind: "commit",
      valueMs: 60 * 60_000,
    });
  });

  it("commits exact fractional minutes and whole minutes", () => {
    expect(resolveLimitCommit({ draft: " 0.25 ", valueMs: 60_000, ...timeout })).toEqual({
      kind: "commit",
      valueMs: 15_000,
    });
    expect(resolveLimitCommit({ draft: "5", valueMs: 60_000, ...timeout })).toEqual({
      kind: "commit",
      valueMs: 5 * 60_000,
    });
  });

  it("rejects empty or non-numeric drafts without committing", () => {
    for (const draft of ["", "  ", "abc", "Infinity"]) {
      expect(resolveLimitCommit({ draft, valueMs: 60_000, ...timeout })).toEqual({
        kind: "invalid",
      });
    }
  });

  it("formats bounds in the unit that keeps them exact", () => {
    expect(formatLimitBound(10_000)).toBe("10 seconds");
    expect(formatLimitBound(60_000)).toBe("1 minute");
    expect(formatLimitBound(60 * 60_000)).toBe("60 minutes");
  });
});
