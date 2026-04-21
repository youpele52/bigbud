/**
 * Claude provider authentication and subscription helpers.
 *
 * Extracted from ClaudeProvider.ts to keep each file under 500 lines.
 * Contains auth-status parsing, subscription-type detection, auth-method
 * extraction, and auth metadata assembly.
 */
import type { ServerProviderAuth, ServerProviderState } from "@bigbud/contracts";
import { Option, Result, Schema } from "effect";
import { decodeJsonResult } from "@bigbud/shared/schemaJson";

import { detailFromResult, extractAuthBoolean, type CommandResult } from "../providerSnapshot";

// ── Auth status parsing ───────────────────────────────────────────────────────

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  ) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", auth: { status: "authenticated" } };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      auth: { status: "unknown" },
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", auth: { status: "authenticated" } };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    auth: { status: "unknown" },
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

// ── Subscription type detection ─────────────────────────────────────────────
//
// The SDK probe returns typed `AccountInfo.subscriptionType` directly.
// This walker is a best-effort fallback for the `claude auth status`
// JSON output whose shape is not guaranteed.

/** Keys that directly hold a subscription/plan identifier. */
const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

/** Keys whose value may be a nested object containing subscription info. */
const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

/** Lift an unknown value into `Option<string>` if it is a non-empty string. */
const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

/** Lift an unknown value into `Option<Record>` if it is a plain object. */
const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !globalThis.Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

function findSubscriptionType(value: unknown): Option.Option<string> {
  if (globalThis.Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }

  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;

      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethod(value: unknown): Option.Option<string> {
  if (globalThis.Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethod));
  }

  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;

      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethod)),
        ),
      );
    }),
  );
}

const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

export function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

export function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethod(parsed.success));
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "max":
    case "maxplan":
    case "max5":
    case "max20":
      return "Max";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

export function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "apikey") return "apiKey";
  return undefined;
}

export function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    const subscriptionLabel = claudeSubscriptionLabel(input.subscriptionType);
    return {
      type: input.subscriptionType,
      label: `Claude ${subscriptionLabel ?? toTitleCaseWords(input.subscriptionType)} Subscription`,
    };
  }

  return undefined;
}
