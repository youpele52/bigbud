import {
  ServerProviderUsageLimits,
  type ServerProviderUsageLimitWindow,
  type ServerProviderUsageLimits as ServerProviderUsageLimitsType,
} from "@bigbud/contracts/server/usageLimits.ts";
import { Data, Effect, Schema } from "effect";

const SOURCE = "claude-agent-sdk" as const;
const SAFE_ERROR_MESSAGE = "Claude subscription limits could not be refreshed.";

class ClaudeUsageLimitsProbeError extends Data.TaggedError("ClaudeUsageLimitsProbeError")<{
  readonly cause: unknown;
}> {}

const FIXED_WINDOWS = [
  ["five_hour", "five-hour", "5-hour limit"],
  ["seven_day", "seven-day", "7-day limit"],
  ["seven_day_oauth_apps", "seven-day-oauth-apps", "7-day OAuth apps limit"],
  ["seven_day_opus", "seven-day-opus", "7-day Opus limit"],
  ["seven_day_sonnet", "seven-day-sonnet", "7-day Sonnet limit"],
] as const;

export function makeClaudeUsageLimitsPending(checkedAt: string): ServerProviderUsageLimitsType {
  return { status: "pending", source: SOURCE, checkedAt, windows: [] };
}

export function makeClaudeUsageLimitsUnavailable(checkedAt: string): ServerProviderUsageLimitsType {
  return { status: "unavailable", source: SOURCE, checkedAt, windows: [] };
}

export function makeClaudeUsageLimitsError(checkedAt: string): ServerProviderUsageLimitsType {
  return {
    status: "error",
    source: SOURCE,
    checkedAt,
    message: SAFE_ERROR_MESSAGE,
    windows: [],
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Claude usage ${field}.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid Claude usage ${field}.`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Claude usage ${field}.`);
  }
  return value;
}

function optionalUtilization(value: unknown, field: string): number | undefined {
  const utilization = optionalNumber(value, field);
  if (utilization !== undefined && utilization > 100) {
    throw new Error(`Invalid Claude usage ${field}.`);
  }
  return utilization;
}

function optionalResetAt(value: unknown, field: string): string | undefined {
  const resetAt = optionalString(value, field);
  if (!resetAt) return undefined;
  const parsed = new Date(resetAt);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid Claude usage ${field}.`);
  return parsed.toISOString();
}

function normalizeWindow(
  value: unknown,
  definition: (typeof FIXED_WINDOWS)[number],
): ServerProviderUsageLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = asRecord(value, definition[0]);
  const utilization = optionalUtilization(window.utilization, `${definition[0]}.utilization`);
  if (utilization === undefined) return undefined;
  const resetAt = optionalResetAt(window.resets_at, `${definition[0]}.resets_at`);
  return {
    id: definition[0],
    kind: definition[1],
    label: definition[2],
    utilization,
    ...(resetAt ? { resetAt } : {}),
  };
}

function normalizeModelWindows(value: unknown): ReadonlyArray<ServerProviderUsageLimitWindow> {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid Claude usage model_scoped.");

  return value
    .flatMap((entry, index): ServerProviderUsageLimitWindow[] => {
      const window = asRecord(entry, `model_scoped[${index}]`);
      const label = optionalString(window.display_name, `model_scoped[${index}].display_name`);
      const utilization = optionalUtilization(
        window.utilization,
        `model_scoped[${index}].utilization`,
      );
      if (!label || utilization === undefined) return [];
      const resetAt = optionalResetAt(window.resets_at, `model_scoped[${index}].resets_at`);
      return [
        {
          id: `model_scoped:${label.toLowerCase()}`,
          kind: "model-scoped",
          label: `${label} 7-day limit`,
          utilization,
          ...(resetAt ? { resetAt } : {}),
        },
      ];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function normalizeExtraUsage(value: unknown): ServerProviderUsageLimitsType["extraUsage"] {
  if (value === null || value === undefined) return undefined;
  const extra = asRecord(value, "extra_usage");
  if (typeof extra.is_enabled !== "boolean") {
    throw new Error("Invalid Claude usage extra_usage.is_enabled.");
  }
  const monthlyLimit = optionalNumber(extra.monthly_limit, "extra_usage.monthly_limit");
  const usedCredits = optionalNumber(extra.used_credits, "extra_usage.used_credits");
  const utilization = optionalUtilization(extra.utilization, "extra_usage.utilization");
  const currency = optionalString(extra.currency, "extra_usage.currency");
  return {
    enabled: extra.is_enabled,
    ...(monthlyLimit === undefined ? {} : { monthlyLimit }),
    ...(usedCredits === undefined ? {} : { usedCredits }),
    ...(utilization === undefined ? {} : { utilization }),
    ...(currency ? { currency } : {}),
  };
}

export function normalizeClaudeUsageLimits(
  value: unknown,
  checkedAt: string,
): ServerProviderUsageLimitsType {
  const response = asRecord(value, "response");
  const subscriptionType = optionalString(response.subscription_type, "subscription_type");
  if (
    response.rate_limits_available === false ||
    response.rate_limits_available === null ||
    response.rate_limits === null
  ) {
    return Schema.decodeUnknownSync(ServerProviderUsageLimits)({
      status: "unavailable",
      source: SOURCE,
      checkedAt,
      windows: [],
      ...(subscriptionType ? { subscriptionType } : {}),
    });
  }
  if (response.rate_limits_available !== true) {
    throw new Error("Invalid Claude usage rate_limits_available.");
  }

  const rateLimits = asRecord(response.rate_limits, "rate_limits");
  const extraUsage = normalizeExtraUsage(rateLimits.extra_usage);
  const windows = FIXED_WINDOWS.flatMap((definition) => {
    const window = normalizeWindow(rateLimits[definition[0]], definition);
    return window ? [window] : [];
  });
  windows.push(...normalizeModelWindows(rateLimits.model_scoped));

  return Schema.decodeUnknownSync(ServerProviderUsageLimits)({
    status: "available",
    source: SOURCE,
    checkedAt,
    lastSuccessfulAt: checkedAt,
    windows,
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(extraUsage ? { extraUsage } : {}),
  });
}

export const readClaudeUsageLimits = Effect.fn("readClaudeUsageLimits")(function* (
  readUsage: () => Promise<unknown>,
  timeoutMs = 2_000,
) {
  const checkedAt = new Date().toISOString();
  return yield* Effect.tryPromise({
    try: async () => normalizeClaudeUsageLimits(await readUsage(), checkedAt),
    catch: (cause) => new ClaudeUsageLimitsProbeError({ cause }),
  }).pipe(
    Effect.timeout(timeoutMs),
    Effect.tapError((cause) =>
      Effect.logWarning("Claude subscription limits probe failed", { cause }),
    ),
    Effect.orElseSucceed(() => makeClaudeUsageLimitsError(checkedAt)),
  );
});
