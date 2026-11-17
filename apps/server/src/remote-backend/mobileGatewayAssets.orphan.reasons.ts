/** Fixed reason codes; reports never carry paths, journal prose or receipt contents. */
export const MOBILE_RUNTIME_REPAIR_REASONS = [
  "proven-orphan",
  "receipt-only",
  "unknown-entry",
  "not-a-directory",
  "in-use",
  "journal-owner-mismatch",
  "no-journal-attempt",
  "ambiguous-journal",
  "attempt-not-exited",
  "pinned",
  "active-stage",
  "receipt-missing",
  "receipt-mismatch",
  "ownership-mismatch",
  "identity-mismatch",
  "tree-changed",
  "removal-failed",
  "budget-exceeded",
  "uncertain",
] as const;
export type MobileRuntimeRepairReason = (typeof MOBILE_RUNTIME_REPAIR_REASONS)[number];
