import { afterAll, describe, expect, it, vi } from "vitest";

import {
  formatHumanReadableDate,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatShortTimestamp,
  formatTimestamp,
  getHumanReadableDateFormatOptions,
  getTimestampFormatOptions,
} from "./timestamp.utils";

// Establish the timezone before importing the module, whose Intl formatters are cached.
const originalTimezone = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  return original;
});

afterAll(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe("getTimestampFormatOptions", () => {
  it("omits hour12 when locale formatting is requested", () => {
    expect(getTimestampFormatOptions("locale", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  });

  it("builds a 12-hour formatter with seconds when requested", () => {
    expect(getTimestampFormatOptions("12-hour", true)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  });

  it("builds a 24-hour formatter without seconds when requested", () => {
    expect(getTimestampFormatOptions("24-hour", false)).toEqual({
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
  });
});

describe("getHumanReadableDateFormatOptions", () => {
  it("builds a locale-aware long date formatter", () => {
    expect(getHumanReadableDateFormatOptions("date")).toEqual({
      dateStyle: "long",
    });
  });

  it("builds a locale-aware long date and short time formatter", () => {
    expect(getHumanReadableDateFormatOptions("date-time")).toEqual({
      dateStyle: "long",
      timeStyle: "short",
    });
  });

  it("builds a locale-aware month and year formatter", () => {
    expect(getHumanReadableDateFormatOptions("month-year")).toEqual({
      month: "long",
      year: "numeric",
    });
  });
});

const timeOf = (date: Date, format: "locale" | "12-hour" | "24-hour" = "24-hour") =>
  new Intl.DateTimeFormat(undefined, getTimestampFormatOptions(format, true)).format(date);
const dateOf = (date: Date, includeYear = false) =>
  new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  }).format(date);

describe("formatTimestamp", () => {
  const now = new Date(2026, 6, 5, 14, 30, 0);

  it.each(["locale", "12-hour", "24-hour"] as const)(
    "keeps today's %s time formatting including seconds",
    (format) => {
      const date = new Date(2026, 6, 5, 9, 8, 7);
      expect(formatTimestamp(date.toISOString(), format, now)).toBe(timeOf(date, format));
    },
  );

  it.each(["locale", "12-hour", "24-hour"] as const)(
    "prefixes yesterday's %s timestamp without changing its time",
    (format) => {
      const date = new Date(2026, 6, 4, 9, 8, 7);
      expect(formatTimestamp(date.toISOString(), format, now)).toBe(
        `Yesterday ${timeOf(date, format)}`,
      );
    },
  );

  it("adds a locale-aware date without the year for older messages this year", () => {
    const date = new Date(2026, 6, 3, 9, 8, 7);
    expect(formatTimestamp(date.toISOString(), "24-hour", now)).toBe(
      `${dateOf(date)} ${timeOf(date)}`,
    );
  });

  it("includes the year for messages outside the current year", () => {
    const date = new Date(2025, 6, 3, 9, 8, 7);
    expect(formatTimestamp(date.toISOString(), "24-hour", now)).toBe(
      `${dateOf(date, true)} ${timeOf(date)}`,
    );
  });

  it("uses yesterday across local midnight even when only seconds have elapsed", () => {
    const date = new Date(2026, 6, 4, 23, 59, 59);
    const justAfterMidnight = new Date(2026, 6, 5, 0, 0, 1);
    expect(formatTimestamp(date.toISOString(), "24-hour", justAfterMidnight)).toBe(
      `Yesterday ${timeOf(date)}`,
    );
  });

  it("uses the calendar date rather than the last 24 hours for yesterday", () => {
    const date = new Date(2026, 6, 4, 0, 0, 0);
    const lateToday = new Date(2026, 6, 5, 23, 59, 59);
    expect(formatTimestamp(date.toISOString(), "24-hour", lateToday)).toBe(
      `Yesterday ${timeOf(date)}`,
    );
  });

  it("recognizes yesterday across month and year boundaries", () => {
    const date = new Date(2025, 11, 31, 23, 59, 59);
    const newYear = new Date(2026, 0, 1, 0, 0, 1);
    expect(formatTimestamp(date.toISOString(), "24-hour", newYear)).toBe(
      `Yesterday ${timeOf(date)}`,
    );
  });

  it.each([
    [new Date(2026, 2, 8, 0, 30), new Date(2026, 2, 9, 0, 15)],
    [new Date(2026, 10, 1, 0, 30), new Date(2026, 10, 2, 0, 15)],
  ])("recognizes yesterday across daylight-saving transitions (%s)", (date, today) => {
    expect(date.getTimezoneOffset()).not.toBe(today.getTimezoneOffset());
    expect(formatTimestamp(date.toISOString(), "24-hour", today)).toBe(`Yesterday ${timeOf(date)}`);
  });

  it("does not mistake a different local day in the same UTC day for today", () => {
    // In America/Los_Angeles these instants share a UTC date, but not a local date.
    const date = new Date("2026-07-05T06:59:59.000Z");
    const today = new Date("2026-07-05T07:00:01.000Z");
    expect(date.toDateString()).not.toBe(today.toDateString());
    expect(formatTimestamp(date.toISOString(), "24-hour", today)).toBe(`Yesterday ${timeOf(date)}`);
  });

  it("refreshes cached times and dates after the system timezone changes", () => {
    const date = "2025-07-04T06:30:00.000Z";
    const today = new Date("2026-07-05T12:00:00.000Z");
    formatTimestamp(date, "24-hour", today);
    formatShortTimestamp(date, "24-hour");
    formatHumanReadableDate(date);
    const previousTimezone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const localDate = new Date(date);
      expect(formatTimestamp(date, "24-hour", today)).toBe(
        `${dateOf(localDate, true)} ${timeOf(localDate)}`,
      );
      expect(formatShortTimestamp(date, "24-hour")).toBe(
        new Intl.DateTimeFormat(undefined, getTimestampFormatOptions("24-hour", false)).format(
          localDate,
        ),
      );
      expect(formatHumanReadableDate(date)).toBe(
        new Intl.DateTimeFormat(undefined, getHumanReadableDateFormatOptions("date")).format(
          localDate,
        ),
      );
    } finally {
      process.env.TZ = previousTimezone;
    }
  });

  it("leaves short activity timestamps time-only", () => {
    const date = new Date(2025, 6, 3, 9, 8, 7);
    expect(formatShortTimestamp(date.toISOString(), "24-hour")).toBe(
      new Intl.DateTimeFormat(undefined, getTimestampFormatOptions("24-hour", false)).format(date),
    );
  });
});

function isoOffsetMs(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

describe("formatRelativeTime", () => {
  it("returns 'just now' for sub-5-second timestamps", () => {
    expect(formatRelativeTime(isoOffsetMs(2_000))).toEqual({ value: "just now", suffix: null });
  });

  it("returns 'just now' for future timestamps", () => {
    expect(formatRelativeTime(new Date(Date.now() + 60_000).toISOString())).toEqual({
      value: "just now",
      suffix: null,
    });
  });

  it("returns seconds without an 'ago' suffix", () => {
    expect(formatRelativeTime(isoOffsetMs(20_000))).toEqual({ value: "20s", suffix: null });
  });

  it("returns minutes without an 'ago' suffix", () => {
    expect(formatRelativeTime(isoOffsetMs(6 * 60_000))).toEqual({ value: "6m", suffix: null });
  });

  it("returns hours without an 'ago' suffix", () => {
    expect(formatRelativeTime(isoOffsetMs(23 * 60 * 60_000))).toEqual({
      value: "23h",
      suffix: null,
    });
  });

  it("returns days without an 'ago' suffix", () => {
    expect(formatRelativeTime(isoOffsetMs(3 * 24 * 60 * 60_000))).toEqual({
      value: "3d",
      suffix: null,
    });
  });

  it("never returns the 'ago' string anywhere in the result", () => {
    const samples = [
      3_000,
      45_000,
      5 * 60_000,
      90 * 60_000,
      26 * 60 * 60_000,
      14 * 24 * 60 * 60_000,
    ];
    for (const offsetMs of samples) {
      const { value, suffix } = formatRelativeTime(isoOffsetMs(offsetMs));
      expect(value).not.toContain("ago");
      expect(suffix).not.toBe("ago");
    }
  });
});

describe("formatHumanReadableDate", () => {
  it("formats ISO timestamps without returning the raw ISO string", () => {
    const isoDate = "2026-07-05T00:00:00.000Z";
    expect(formatHumanReadableDate(isoDate)).not.toBe(isoDate);
  });
});

describe("formatRelativeTimeLabel", () => {
  it("returns the bare value without an 'ago' suffix", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(formatRelativeTimeLabel(oneHourAgo)).toBe("1h");
  });

  it("returns 'just now' for very recent timestamps", () => {
    expect(formatRelativeTimeLabel(new Date().toISOString())).toBe("just now");
  });

  it("returns day values without 'ago'", () => {
    const elevenDaysAgo = new Date(Date.now() - 11 * 24 * 60 * 60_000).toISOString();
    expect(formatRelativeTimeLabel(elevenDaysAgo)).toBe("11d");
  });
});
