/**
 * Dormant protected-policy recovery and one-time legacy migration (plan M3
 * "Marker-absent migration …", M5 "migrate deterministically once"). Pure:
 * reads a parsed settings record, never writes, and is not wired into
 * settings persistence while legacy Driver 0.9.1 stays selected.
 *
 * - Valid marker + verified digest: current policy, unchanged.
 * - Marker absent, recognized raw legacy fields, no known native migration:
 *   migrate once, keeping enablement as INTENT, limits as stored and empty
 *   disallows; the first activation still requires an explicit human Resume.
 * - Nothing persisted: new installation, disabled. (Legacy defaults are
 *   stripped on save, so an untouched legacy install is equivalent.)
 * - Anything else fails closed: corrupt/partial group, future format, digest
 *   mismatch, group lost after a known native migration, or malformed legacy
 *   fields (including present-but-null). Never field-wise grant-all recovery.
 *
 * `requiresResume` is NOT persisted in the group. Safety therefore depends on
 * the native side: a first supervised start has no native safety record and
 * starts latched, so Resume is required regardless; once native records the
 * migration (`nativeMigrationKnown`), the group is simply `current`.
 */
import {
  COMPUTER_USE_POLICY_FORMAT,
  ComputerUsePolicyGroup,
} from "@bigbud/contracts/core/settings.computerUsePolicy";
import {
  ComputerUseActionTimeoutMs,
  ComputerUseCheckInIntervalMs,
  DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS,
  DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS,
} from "@bigbud/contracts/core/settings.serverShared";
import { Schema } from "effect";

import { sealPolicy, verifyPolicy } from "./policy.digest";

export const COMPUTER_USE_POLICY_SETTINGS_KEY = "computerUsePolicy";
const LEGACY_KEYS = [
  "computerUseEnabled",
  "computerUseCheckInIntervalMs",
  "computerUseActionTimeoutMs",
] as const;

export type PolicyFailClosedReason =
  | "corrupt"
  | "unsupported_format"
  | "digest_mismatch"
  | "marker_lost"
  | "unrecognized_legacy"
  | "invalid_authority";

export type PolicyRecovery =
  | { readonly kind: "current"; readonly group: ComputerUsePolicyGroup }
  | {
      readonly kind: "migrated";
      readonly group: ComputerUsePolicyGroup;
      readonly requiresResume: true;
    }
  | { readonly kind: "new_install"; readonly group: ComputerUsePolicyGroup }
  | { readonly kind: "fail_closed"; readonly reason: PolicyFailClosedReason };

export interface PolicyRecoveryInput {
  /** Parsed settings document (untrusted shape). */
  readonly settings: unknown;
  /** Native safety binding already records a completed migration. */
  readonly nativeMigrationKnown: boolean;
  /** Fresh revision namespace for a migrated or newly created group. */
  readonly authorityId: string;
}

const failClosed = (reason: PolicyFailClosedReason): PolicyRecovery => ({
  kind: "fail_closed",
  reason,
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePolicyGroup = Schema.decodeUnknownOption(ComputerUsePolicyGroup);
/** Unknown keys inside the protected group are corruption, not data. */
const decodeGroup = (value: unknown) => decodePolicyGroup(value, { onExcessProperty: "error" });
const isEnabled = Schema.is(Schema.Boolean);
const isCheckIn = Schema.is(ComputerUseCheckInIntervalMs);
const isTimeout = Schema.is(ComputerUseActionTimeoutMs);

/** Verifies a stored protected group exactly (format, shape, digest). */
export function verifyStoredPolicyGroup(stored: unknown): PolicyRecovery {
  if (isRecord(stored) && typeof stored.format === "string") {
    if (stored.format !== COMPUTER_USE_POLICY_FORMAT) return failClosed("unsupported_format");
  }
  const decoded = decodeGroup(stored);
  if (decoded._tag === "None") return failClosed("corrupt");
  const verified = verifyPolicy(decoded.value);
  if (verified.ok) return { kind: "current", group: verified.group };
  return failClosed(verified.refusal === "digest_mismatch" ? "digest_mismatch" : "corrupt");
}

export function recoverComputerUsePolicy(input: PolicyRecoveryInput): PolicyRecovery {
  if (!isRecord(input.settings)) return failClosed("corrupt");
  const settings = input.settings;
  if (Object.hasOwn(settings, COMPUTER_USE_POLICY_SETTINGS_KEY)) {
    return verifyStoredPolicyGroup(settings[COMPUTER_USE_POLICY_SETTINGS_KEY]);
  }
  if (input.nativeMigrationKnown) return failClosed("marker_lost");
  const present = LEGACY_KEYS.filter((key) => Object.hasOwn(settings, key));
  // A present key must hold a valid value; `null` is not "absent".
  const read = (key: (typeof LEGACY_KEYS)[number], fallback: unknown) =>
    Object.hasOwn(settings, key) ? settings[key] : fallback;
  const enabled = read("computerUseEnabled", false);
  const checkIn = read("computerUseCheckInIntervalMs", DEFAULT_COMPUTER_USE_CHECK_IN_INTERVAL_MS);
  const timeout = read("computerUseActionTimeoutMs", DEFAULT_COMPUTER_USE_ACTION_TIMEOUT_MS);
  if (!isEnabled(enabled) || !isCheckIn(checkIn) || !isTimeout(timeout)) {
    return failClosed("unrecognized_legacy");
  }
  const sealed = sealPolicy({
    format: COMPUTER_USE_POLICY_FORMAT,
    authorityId: input.authorityId,
    revision: "1",
    enabled: present.length > 0 && enabled,
    disallowedApps: [],
    defaultDeliveryMode: "foreground",
    checkInIntervalMs: checkIn,
    actionTimeoutMs: timeout,
    diagnosticMetadataEnabled: false,
  });
  if (!sealed.ok) return failClosed("invalid_authority");
  return present.length > 0
    ? { kind: "migrated", group: sealed.group, requiresResume: true }
    : { kind: "new_install", group: sealed.group };
}
