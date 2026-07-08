import { type TimestampFormat } from "@bigbud/contracts/settings";

export type HumanReadableDateFormat = "date" | "date-time" | "month-year";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

export function getHumanReadableDateFormatOptions(
  format: HumanReadableDateFormat,
): Intl.DateTimeFormatOptions {
  if (format === "month-year") {
    return {
      month: "long",
      year: "numeric",
    };
  }

  if (format === "date-time") {
    return {
      dateStyle: "long",
      timeStyle: "short",
    };
  }

  return {
    dateStyle: "long",
  };
}

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();
const humanReadableDateFormatterCache = new Map<HumanReadableDateFormat, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function getHumanReadableDateFormatter(format: HumanReadableDateFormat): Intl.DateTimeFormat {
  const cachedFormatter = humanReadableDateFormatterCache.get(format);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(undefined, getHumanReadableDateFormatOptions(format));
  humanReadableDateFormatterCache.set(format, formatter);
  return formatter;
}

export function formatHumanReadableDate(
  value: string | Date,
  format: HumanReadableDateFormat = "date",
): string {
  const date = value instanceof Date ? value : new Date(value);
  return getHumanReadableDateFormatter(format).format(date);
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, true).format(new Date(isoDate));
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  return getTimestampFormatter(timestampFormat, false).format(new Date(isoDate));
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: null }` for a sub-minute timestamp and
 * `{ value: "just now", suffix: null }` for very recent timestamps.
 * The `suffix` field is always `null` and is retained for backwards compatibility
 * with callers that style the numeric portion independently.
 */
export function formatRelativeTime(isoDate: string): { value: string; suffix: string | null } {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 0) return { value: "just now", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: "just now", suffix: null };
  if (seconds < 60) return { value: `${seconds}s`, suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}m`, suffix: null };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}h`, suffix: null };
  const days = Math.floor(hours / 24);
  return { value: `${days}d`, suffix: null };
}

export function formatRelativeTimeLabel(isoDate: string) {
  return formatRelativeTime(isoDate).value;
}
