import { describe, expect, it } from "vitest";

import {
  formatHumanReadableDate,
  formatRelativeTime,
  formatRelativeTimeLabel,
  getHumanReadableDateFormatOptions,
  getTimestampFormatOptions,
} from "./timestamp.utils";

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
