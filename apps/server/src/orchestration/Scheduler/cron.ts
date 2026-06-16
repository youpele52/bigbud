export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

const WEEKDAY_INDEX_BY_SHORT_NAME = {
  Fri: 5,
  Mon: 1,
  Sat: 6,
  Sun: 0,
  Thu: 4,
  Tue: 2,
  Wed: 3,
} as const;

type CronField = {
  readonly min: number;
  readonly max: number;
  readonly values: ReadonlySet<number>;
};

function parseRange(
  token: string,
  min: number,
  max: number,
  allowSundaySeven = false,
): ReadonlySet<number> {
  if (token === "*") {
    return new Set(Array.from({ length: max - min + 1 }, (_, i) => min + i));
  }

  if (token.startsWith("*/")) {
    const step = Number(token.slice(2));
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronParseError(`Invalid cron step: ${token}`);
    }
    const values: number[] = [];
    for (let value = min; value <= max; value += step) {
      values.push(value);
    }
    return new Set(values);
  }

  const values = new Set<number>();
  for (const part of token.split(",")) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = Number(startStr);
      const end = Number(endStr);
      const normalizedStart = allowSundaySeven && start === 7 ? 0 : start;
      const normalizedEnd = allowSundaySeven && end === 7 ? 0 : end;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        normalizedStart < min ||
        normalizedEnd > max ||
        normalizedStart > normalizedEnd
      ) {
        throw new CronParseError(`Invalid cron range: ${part}`);
      }
      for (let value = normalizedStart; value <= normalizedEnd; value++) {
        values.add(value);
      }
    } else {
      const value = Number(part);
      const normalizedValue = allowSundaySeven && value === 7 ? 0 : value;
      if (!Number.isInteger(value) || normalizedValue < min || normalizedValue > max) {
        throw new CronParseError(`Invalid cron value: ${part}`);
      }
      values.add(normalizedValue);
    }
  }
  return values;
}

function parseCronExpression(expression: string): {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
} {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(`Cron expression must have 5 fields: ${expression}`);
  }

  return {
    minute: { min: 0, max: 59, values: parseRange(fields[0]!, 0, 59) },
    hour: { min: 0, max: 23, values: parseRange(fields[1]!, 0, 23) },
    dayOfMonth: { min: 1, max: 31, values: parseRange(fields[2]!, 1, 31) },
    month: { min: 1, max: 12, values: parseRange(fields[3]!, 1, 12) },
    dayOfWeek: { min: 0, max: 6, values: parseRange(fields[4]!, 0, 6, true) },
  };
}

const dateTimePartsFormatters = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const existing = dateTimePartsFormatters.get(timeZone);
  if (existing) {
    return existing;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hour12: false,
    minute: "numeric",
    month: "numeric",
    timeZone,
    weekday: "short",
    year: "numeric",
  });
  dateTimePartsFormatters.set(timeZone, formatter);
  return formatter;
}

function getZonedDateParts(date: Date, timeZone: string) {
  const parts = getDateTimeFormatter(timeZone).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value] as const));
  const weekday = byType.get("weekday");
  if (!weekday || !(weekday in WEEKDAY_INDEX_BY_SHORT_NAME)) {
    throw new CronParseError(`Invalid timezone weekday for: ${timeZone}`);
  }

  return {
    dayOfMonth: Number(byType.get("day")),
    dayOfWeek: WEEKDAY_INDEX_BY_SHORT_NAME[weekday as keyof typeof WEEKDAY_INDEX_BY_SHORT_NAME],
    hour: Number(byType.get("hour")),
    minute: Number(byType.get("minute")),
    month: Number(byType.get("month")),
  };
}

function matchesCronFields(
  date: Date,
  fields: ReturnType<typeof parseCronExpression>,
  timeZone: string,
): boolean {
  const zoned = getZonedDateParts(date, timeZone);
  return (
    fields.minute.values.has(zoned.minute) &&
    fields.hour.values.has(zoned.hour) &&
    fields.dayOfMonth.values.has(zoned.dayOfMonth) &&
    fields.month.values.has(zoned.month) &&
    fields.dayOfWeek.values.has(zoned.dayOfWeek)
  );
}

const MAX_ITERATIONS = 4 * 366 * 24 * 60; // ~4 years of minutes

export function getNextCronTime(expression: string, after: Date, timeZone = "UTC"): Date {
  const fields = parseCronExpression(expression);
  try {
    getDateTimeFormatter(timeZone);
  } catch (error) {
    throw new CronParseError(
      error instanceof Error ? `Invalid timezone: ${timeZone}` : String(error),
    );
  }
  const candidate = new Date(
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      after.getUTCHours(),
      after.getUTCMinutes(),
      0,
      0,
    ),
  );
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (matchesCronFields(candidate, fields, timeZone)) {
      return candidate;
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  throw new CronParseError(`No next cron time found within ~4 years for: ${expression}`);
}
