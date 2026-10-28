/**
 * Dormant protected computer-use policy group (plan M3 "Application
 * restrictions and revision transactions", M5 "App restrictions"). Schema
 * only: not yet part of `ServerSettings`, not persisted or read while legacy
 * Driver 0.9.1 stays selected. The canonical encoding/digest live in
 * `@bigbud/shared/computer-use/policy.canonical` and are frozen by
 * `protocol/computer-use/policy.v1.golden`.
 */
import { Schema } from "effect";

import { ComputerUseActionTimeoutMs, ComputerUseCheckInIntervalMs } from "./settings.serverShared";

export const COMPUTER_USE_POLICY_FORMAT = "bigbud.computerUsePolicy.v1";
export const COMPUTER_USE_SELECTOR_VALUE_MAX_CHARS = 1024;
export const COMPUTER_USE_SELECTOR_LABEL_MAX_CHARS = 256;

/** Same alphabet/bound as native `valid_id`. */
export const ComputerUsePolicyId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/),
);
/** Canonical decimal u64 text: no sign, no leading zero (native `parse_revision`). */
export const ComputerUsePolicyRevision = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/),
);
export const ComputerUsePolicyDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** Printable text: no C0 controls or DEL (they would break canonical framing). */
const SelectorValue = Schema.String.check(
  // oxlint-disable-next-line no-control-regex -- C0/DEL are refused deliberately (canonical framing)
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
  Schema.isMaxLength(COMPUTER_USE_SELECTOR_VALUE_MAX_CHARS),
);
/** Presentation only; never authorization and excluded from the digest. */
const SelectorLabel = Schema.optional(
  SelectorValue.check(Schema.isMaxLength(COMPUTER_USE_SELECTOR_LABEL_MAX_CHARS)),
);

export const ComputerUseAppSelector = Schema.Union([
  Schema.Struct({
    platform: Schema.Literal("macos"),
    kind: Schema.Literals(["bundle_id", "code_requirement", "path"]),
    value: SelectorValue,
    label: SelectorLabel,
  }),
  Schema.Struct({
    platform: Schema.Literal("windows"),
    kind: Schema.Literals(["aumid", "package_family", "executable"]),
    value: SelectorValue,
    label: SelectorLabel,
  }),
  Schema.Struct({
    platform: Schema.Literal("linux"),
    kind: Schema.Literals(["desktop_entry", "executable"]),
    value: SelectorValue,
    label: SelectorLabel,
  }),
]);
export type ComputerUseAppSelector = typeof ComputerUseAppSelector.Type;

export const ComputerUseDeliveryMode = Schema.Literals(["foreground", "background"]);
export type ComputerUseDeliveryMode = typeof ComputerUseDeliveryMode.Type;

/** Every field the canonical digest covers (all except `digest`). */
export const ComputerUsePolicyBody = Schema.Struct({
  format: Schema.Literal(COMPUTER_USE_POLICY_FORMAT),
  authorityId: ComputerUsePolicyId,
  revision: ComputerUsePolicyRevision,
  enabled: Schema.Boolean,
  disallowedApps: Schema.Array(ComputerUseAppSelector),
  defaultDeliveryMode: ComputerUseDeliveryMode,
  checkInIntervalMs: ComputerUseCheckInIntervalMs,
  actionTimeoutMs: ComputerUseActionTimeoutMs,
  diagnosticMetadataEnabled: Schema.Boolean,
});
export type ComputerUsePolicyBody = typeof ComputerUsePolicyBody.Type;

/** Complete atomic group; every field is required (no defaulting/recovery). */
export const ComputerUsePolicyGroup = Schema.Struct({
  ...ComputerUsePolicyBody.fields,
  digest: ComputerUsePolicyDigest,
});
export type ComputerUsePolicyGroup = typeof ComputerUsePolicyGroup.Type;
