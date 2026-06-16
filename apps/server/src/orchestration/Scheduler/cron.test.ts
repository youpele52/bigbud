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
});
