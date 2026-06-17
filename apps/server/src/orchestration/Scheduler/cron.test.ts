import { describe, expect, it } from "vitest";

import { CronParseError, getNextCronTime } from "./cron";

describe("cron", () => {
  it("parses an exact minute expression", () => {
    const after = new Date("2026-06-16T10:30:00.000Z");
    const next = getNextCronTime("30 11 * * *", after);
    expect(next.toISOString()).toBe("2026-06-16T11:30:00.000Z");
  });

  it("parses a wildcard minute expression", () => {
    const after = new Date("2026-06-16T10:30:45.000Z");
    const next = getNextCronTime("* 11 * * *", after);
    expect(next.toISOString()).toBe("2026-06-16T11:00:00.000Z");
  });

  it("steps with slash syntax", () => {
    const after = new Date("2026-06-16T10:00:00.000Z");
    const next = getNextCronTime("*/15 * * * *", after);
    expect(next.toISOString()).toBe("2026-06-16T10:15:00.000Z");
  });

  it("matches a range", () => {
    const after = new Date("2026-06-16T10:00:00.000Z");
    const next = getNextCronTime("0 9-17 * * 1-5", after);
    expect(next.toISOString()).toBe("2026-06-16T11:00:00.000Z");
  });

  it("matches a list", () => {
    const after = new Date("2026-06-16T10:00:00.000Z");
    const next = getNextCronTime("0 8,12,18 * * *", after);
    expect(next.toISOString()).toBe("2026-06-16T12:00:00.000Z");
  });

  it("rolls over to the next day", () => {
    const after = new Date("2026-06-16T23:59:00.000Z");
    const next = getNextCronTime("0 0 * * *", after);
    expect(next.toISOString()).toBe("2026-06-17T00:00:00.000Z");
  });

  it("respects day of week", () => {
    const after = new Date("2026-06-16T00:00:00.000Z"); // Tuesday
    const next = getNextCronTime("0 9 * * 1", after);
    expect(next.toISOString()).toBe("2026-06-22T09:00:00.000Z"); // next Monday
  });

  it("respects the configured timezone", () => {
    const after = new Date("2026-06-16T10:30:00.000Z");
    const next = getNextCronTime("0 9 * * *", after, "America/New_York");
    expect(next.toISOString()).toBe("2026-06-16T13:00:00.000Z");
  });

  it("rejects expressions with the wrong number of fields", () => {
    expect(() => getNextCronTime("* * * *", new Date())).toThrow(CronParseError);
    expect(() => getNextCronTime("* * * * * *", new Date())).toThrow(CronParseError);
  });

  it("rejects invalid values", () => {
    expect(() => getNextCronTime("60 * * * *", new Date())).toThrow(CronParseError);
    expect(() => getNextCronTime("* 24 * * *", new Date())).toThrow(CronParseError);
    expect(() => getNextCronTime("* * 0 * *", new Date())).toThrow(CronParseError);
    expect(() => getNextCronTime("* * * 13 *", new Date())).toThrow(CronParseError);
  });

  it("rejects invalid timezones", () => {
    expect(() => getNextCronTime("* * * * *", new Date(), "Mars/Olympus")).toThrow(CronParseError);
  });

  it("handles Sunday as 0 and 7 in day-of-week field", () => {
    const after = new Date("2026-06-16T00:00:00.000Z"); // Tuesday
    const sundayZero = getNextCronTime("0 9 * * 0", after, "UTC");
    const sundaySeven = getNextCronTime("0 9 * * 7", after, "UTC");
    expect(sundayZero.toISOString()).toBe(sundaySeven.toISOString());
  });

  it("rejects impossible day-of-month values", () => {
    expect(() => getNextCronTime("0 9 31 2 *", new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      CronParseError,
    );
  });

  it("advances across a spring-forward DST gap in America/New_York", () => {
    const after = new Date("2026-03-08T06:30:00.000Z"); // 1:30 AM EST
    const next = getNextCronTime("30 2 * * *", after, "America/New_York");
    expect(next.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("matches both occurrences of a fall-back duplicate local time", () => {
    const after = new Date("2026-11-01T05:29:00.000Z"); // 1:29 AM EDT
    const first = getNextCronTime("30 1 * * *", after, "America/New_York");
    const second = getNextCronTime("30 1 * * *", first, "America/New_York");
    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(second.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });

  it("requires day-of-month and day-of-week to both match", () => {
    const after = new Date("2026-06-01T00:00:00.000Z"); // Monday June 1
    const next = getNextCronTime("0 9 15 * 1", after, "UTC");
    expect(next.toISOString()).toBe("2026-06-15T09:00:00.000Z"); // Monday June 15
  });
});
