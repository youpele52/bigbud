import { getTimestampFormatOptions } from "~/utils/timestamp/timestamp.utils";

/** Keeps subscription dates consistent in the device zone, with DST at the timestamp. */
export function formatSubscriptionTimestamp(value: string): string {
  const date = new Date(value);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...getTimestampFormatOptions("12-hour", false),
    timeZoneName: "short",
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const zone = subscriptionTimeZoneName(
    date,
    parts.get("timeZoneName"),
    formatter.resolvedOptions().timeZone,
  );
  return `${parts.get("month")} ${parts.get("day")}, ${parts.get("year")} at ${parts.get("hour")}:${parts.get("minute")} ${parts.get("dayPeriod")!.toUpperCase()} ${zone}`;
}

function isNamedTimeZone(name: string | undefined): name is string {
  return typeof name === "string" && name.length > 0 && !/^(?:GMT|UTC)[+\-\u2212]/.test(name);
}

function subscriptionTimeZoneName(
  date: Date,
  initialName: string | undefined,
  timeZone: string,
): string {
  if (isNamedTimeZone(initialName)) return initialName;
  // English CLDR data differs: en-GB supplies CET/CEST, while en-US supplies PST/PDT.
  for (const [locale, timeZoneName] of [
    ["en-US", "short"],
    ["en-GB", "long"],
  ] as const) {
    const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value;
    if (isNamedTimeZone(name)) return name;
  }
  // Some fixed-offset zones have no localized name; keep the real identifier, never invent one.
  return timeZone;
}
