/**
 * Dormant protected-policy watch reconciliation (plan M3 "Treat file-watch
 * events as invalidations, not automatic policy changes"). Pure: never writes
 * and is not wired while legacy Driver 0.9.1 stays selected.
 *
 * Caller contract: on any settings watch event, invalidate the cached policy
 * snapshot synchronously first, then reread the file and pass the result
 * here. Admission rereads through the same function.
 *
 * - The same verified group the server last persisted (an ordinary settings
 *   save, including atomic renames) is `unchanged`: it never pauses.
 * - The exact revision/digest of this server's own pending Apply is
 *   `own_apply`; acknowledgement still comes from native separately.
 * - Missing, unreadable, corrupt or otherwise changed policy `fence`s. The
 *   file is preserved, and only a human Apply under a fresh revision can
 *   replace it; an external edit never becomes effective by itself.
 */
import type { ComputerUsePolicyGroup } from "@bigbud/contracts/core/settings.computerUsePolicy";

import {
  COMPUTER_USE_POLICY_SETTINGS_KEY,
  type PolicyFailClosedReason,
  verifyStoredPolicyGroup,
} from "./policy.migration";

export interface PolicyIdentity {
  readonly authorityId: string;
  readonly revision: string;
  readonly digest: string;
}

export type PolicyReread =
  | { readonly kind: "unreadable" }
  | { readonly kind: "document"; readonly settings: unknown };

export interface PolicyWatchInput {
  readonly reread: PolicyReread;
  /** The group this server last persisted; `null` before any binding. */
  readonly expected: PolicyIdentity | null;
  /**
   * A dedicated Apply this server is writing right now, if any. The caller
   * must clear it (and move it to `expected`) once that Apply is persisted
   * and acknowledged; a stale value would let a later external rollback to
   * exactly that group read as `own_apply`.
   */
  readonly pendingApply: PolicyIdentity | null;
}

export type PolicyFenceReason = "unreadable" | "missing" | "changed" | PolicyFailClosedReason;

export type PolicyWatchDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "own_apply"; readonly group: ComputerUsePolicyGroup }
  | { readonly kind: "fence"; readonly reason: PolicyFenceReason };

const fence = (reason: PolicyFenceReason): PolicyWatchDecision => ({ kind: "fence", reason });
const sameIdentity = (group: ComputerUsePolicyGroup, identity: PolicyIdentity | null) =>
  identity !== null &&
  group.authorityId === identity.authorityId &&
  group.revision === identity.revision &&
  group.digest === identity.digest;

export function reconcilePolicyWatch(input: PolicyWatchInput): PolicyWatchDecision {
  if (input.reread.kind === "unreadable") return fence("unreadable");
  const settings = input.reread.settings;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return fence("corrupt");
  }
  if (!Object.hasOwn(settings, COMPUTER_USE_POLICY_SETTINGS_KEY)) {
    // Nothing bound yet means nothing to protect; otherwise the group is lost.
    return input.expected === null ? { kind: "unchanged" } : fence("missing");
  }
  const stored = (settings as Record<string, unknown>)[COMPUTER_USE_POLICY_SETTINGS_KEY];
  const verified = verifyStoredPolicyGroup(stored);
  if (verified.kind === "fail_closed") return fence(verified.reason);
  if (verified.kind !== "current") return fence("corrupt");
  if (sameIdentity(verified.group, input.expected)) return { kind: "unchanged" };
  if (sameIdentity(verified.group, input.pendingApply)) {
    return { kind: "own_apply", group: verified.group };
  }
  return fence("changed");
}
