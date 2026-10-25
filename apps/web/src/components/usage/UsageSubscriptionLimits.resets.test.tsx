import type { ServerProviderManualResets } from "@bigbud/contracts/server/usageLimits.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageSubscriptionManualResets } from "./UsageSubscriptionLimits.resets";
import { limitResetExpiryRows } from "./UsageSubscriptionLimits.resets.logic";
import { formatSubscriptionTimestamp } from "./UsageSubscriptionLimits.timestamp";

const NativeDateTimeFormat = Intl.DateTimeFormat;
const expiry = "2026-10-29T19:06:00Z";
const render = (resets: ServerProviderManualResets) =>
  renderToStaticMarkup(<UsageSubscriptionManualResets resets={resets} />);

afterEach(() => vi.restoreAllMocks());

describe("local subscription timestamp formatting", () => {
  it.each([
    ["Europe/Paris", expiry, "October 29, 2026 at 8:06 PM CET"],
    ["Europe/Paris", "2026-07-29T18:06:00Z", "July 29, 2026 at 8:06 PM CEST"],
    ["Europe/Paris", "2026-10-21T17:00:00Z", "October 21, 2026 at 7:00 PM CEST"],
    ["America/Los_Angeles", "2026-10-29T03:06:00Z", "October 28, 2026 at 8:06 PM PDT"],
    ["America/Los_Angeles", "2026-11-29T04:06:00Z", "November 28, 2026 at 8:06 PM PST"],
    ["Asia/Kolkata", expiry, "October 30, 2026 at 12:36 AM India Standard Time"],
    ["America/New_York", expiry, "October 29, 2026 at 3:06 PM EDT"],
    ["UTC", expiry, "October 29, 2026 at 7:06 PM UTC"],
    ["UTC", "2026-10-03T00:06:00Z", "October 3, 2026 at 12:06 AM UTC"],
    ["UTC", "2026-10-03T12:06:00Z", "October 3, 2026 at 12:06 PM UTC"],
  ])(
    "uses the device zone %s, including expiry-specific daylight saving",
    (timeZone, value, expected) => {
      const formatter = vi
        .spyOn(Intl, "DateTimeFormat")
        .mockImplementation(function (locales, options) {
          return new NativeDateTimeFormat(locales, { ...options, timeZone });
        });
      expect(formatSubscriptionTimestamp(value)).toBe(expected);
      expect(formatter).toHaveBeenCalledWith(
        "en-GB",
        expect.objectContaining({ timeZoneName: "short", month: "long", hour12: true }),
      );
      expect(formatter.mock.calls[0]?.[1]).not.toHaveProperty("timeZone");
    },
  );

  it("uses the real local identifier when every localized zone name is only a GMT offset", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new NativeDateTimeFormat(locales, { ...options, timeZone: "Etc/GMT-9" });
    });
    expect(formatSubscriptionTimestamp(expiry)).toBe("October 30, 2026 at 4:06 AM Etc/GMT-9");
  });
});

describe("available limit resets", () => {
  it("keeps every duplicate expiry and uses stable occurrence keys rather than list positions", () => {
    const rows = limitResetExpiryRows([expiry, expiry, null, null]);
    expect(rows.map((row) => row.expiry)).toEqual([expiry, expiry, null, null]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(4);
    expect(
      limitResetExpiryRows(["2026-10-28T19:06:00Z", expiry, expiry, null, null]).slice(1),
    ).toEqual(rows);
  });

  it("reuses the selected toggle style without exposing a switchable or invented History", () => {
    const html = render({
      availableCount: 2,
      availableExpiries: [expiry, expiry],
      detailsComplete: true,
    });
    expect(html).toContain("Limit resets");
    expect(html).toContain("Available (2)");
    expect(html).toContain('data-slot="toggle-group"');
    expect(html).toContain('data-variant="toolbar"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("disabled=");
    expect(html).not.toMatch(/Banked resets|History|Redeem|Use reset|1 ·|\bborder-t\b|divide-y/);
    expect(html.match(/data-slot="separator"/g)).toHaveLength(1);
    expect(html.indexOf('data-slot="separator"')).toBeLessThan(html.indexOf("<h4"));
    expect(html.match(/<li\b/g)).toHaveLength(2);
    expect(html.match(/<time\b/g)).toHaveLength(2);
    expect(html.match(/dateTime="2026-10-29T19:06:00Z"/gi)).toHaveLength(2);
  });

  it("keeps individual no-expiry resets and distinguishes missing partial details", () => {
    const html = render({
      availableCount: 4,
      availableExpiries: [expiry, null, null],
      detailsComplete: false,
    });
    expect(html).toContain("Available (4)");
    expect(html.match(/<li\b/g)).toHaveLength(3);
    expect(html.match(/No expiry/g)).toHaveLength(2);
    expect(html).toContain("Expiry unavailable for 1 reset");
    expect(html).not.toContain("1 ·");
  });

  it("retains count-only and zero states without fabricated expiry rows", () => {
    const unknown = render({ availableCount: 3, availableExpiries: [], detailsComplete: false });
    expect(unknown).toContain("Available (3)");
    expect(unknown).toContain("Expiry unavailable for 3 resets");
    expect(unknown).not.toMatch(/<li\b|<time\b|No expiry|History/);
    const zero = render({ availableCount: 0, availableExpiries: [], detailsComplete: true });
    expect(zero).toContain("Available (0)");
    expect(zero).toContain("No available resets");
    expect(zero).not.toMatch(/<li\b|<time\b|Expiry unavailable|History/);
  });

  it("retains the incomplete-data warning even if all returned expiry slots are known", () => {
    const html = render({ availableCount: 1, availableExpiries: [null], detailsComplete: false });
    expect(html).toContain("No expiry");
    expect(html).toContain("Expiry details may be incomplete");
  });
});
