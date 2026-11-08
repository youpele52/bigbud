import { afterEach, describe, expect, it, vi } from "vitest";

import { formatTimestamp } from "../../../utils/timestamp/timestamp.utils";
import { formatMessageMeta, formatWorkingTimer } from "./MessagesTimeline.assistantMessage.meta";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatMessageMeta", () => {
  it("uses the subscribed calendar day while preserving a completed duration", () => {
    const createdAt = new Date(2026, 6, 5, 9, 8, 7).toISOString();
    const nextDay = new Date(2026, 6, 6);
    expect(formatMessageMeta(createdAt, "1m 2s", "24-hour", nextDay)).toBe(
      `${formatTimestamp(createdAt, "24-hour", nextDay)} • 1m 2s`,
    );
    expect(formatMessageMeta(createdAt, null, "24-hour", nextDay)).toBe(
      formatTimestamp(createdAt, "24-hour", nextDay),
    );
  });

  it.each([
    new Date(2026, 6, 5, 9, 8, 7),
    new Date(2026, 6, 4, 9, 8, 7),
    new Date(2026, 6, 3, 9, 8, 7),
    new Date(2025, 6, 3, 9, 8, 7),
  ])("uses the shared message timestamp with and without a duration (%s)", (date) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 5, 14, 30));
    const isoDate = date.toISOString();
    const timestamp = formatTimestamp(isoDate, "24-hour");
    expect(formatMessageMeta(isoDate, null, "24-hour")).toBe(timestamp);
    expect(formatMessageMeta(isoDate, "1m 2s", "24-hour")).toBe(`${timestamp} • 1m 2s`);
  });
});

describe("formatWorkingTimer", () => {
  it("keeps elapsed durations independent of calendar-day labels", () => {
    expect(formatWorkingTimer("2026-07-04T23:59:00Z", "2026-07-05T00:00:02Z")).toBe("1m 2s");
  });
});
