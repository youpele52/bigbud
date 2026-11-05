/**
 * Frozen canonical encoding of the protected computer-use policy (plan M3:
 * "UTF-8, fixed field ordering, decimal revisions, deterministic selector
 * ordering"). Golden vectors: `protocol/computer-use/policy.v1.golden`; the
 * native owner decodes/re-encodes the same bytes before acknowledging.
 *
 * Layout (UTF-8, every line `\n`-terminated, fixed order):
 *   bigbud.computerUsePolicy.v1
 *   authority=<id>            revision=<canonical decimal>
 *   enabled=<0|1>             delivery=<foreground|background>
 *   check_in_ms=<decimal>     action_timeout_ms=<decimal>
 *   diagnostics=<0|1>         disallowed=<count>
 *   app=<platform>\t<kind>\t<value>   (one per selector)
 * Selectors sort by the UTF-8 bytes of `platform\tkind\tvalue`; duplicates
 * refuse. Labels are presentation only and are not encoded.
 */
import {
  COMPUTER_USE_POLICY_FORMAT,
  type ComputerUseAppSelector,
  type ComputerUsePolicyBody,
} from "@bigbud/contracts/core/settings.computerUsePolicy";
import {
  COMPUTER_USE_ACTION_TIMEOUT_MS_MAX,
  COMPUTER_USE_ACTION_TIMEOUT_MS_MIN,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX,
  COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN,
} from "@bigbud/contracts/core/settings.serverShared";

/** Native `MAX_CANONICAL_POLICY_BYTES`. */
export const MAX_CANONICAL_POLICY_BYTES = 64 * 1024;
const U64_MAX = 18_446_744_073_709_551_615n;

export type CanonicalPolicyRefusal =
  | "invalid_revision"
  | "duplicate_selector"
  | "invalid_text"
  | "out_of_range"
  | "oversized";

export type CanonicalPolicy =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly refusal: CanonicalPolicyRefusal };

const encoder = new TextEncoder();

/** Bytewise UTF-8 order (NOT JavaScript's UTF-16 code-unit order). */
export function compareUtf8(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

// Lone surrogates would be replaced by U+FFFD during encoding: refuse instead.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// oxlint-disable-next-line no-control-regex -- C0/DEL are refused deliberately (canonical framing)
const FRAMING_CONTROL = /[\u0000-\u001f\u007f]/;
const POLICY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const within = (value: number, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && value >= min && value <= max;
/** Same closed platform/kind table as the schema and the native decoder. */
const SELECTOR_KINDS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["macos", ["bundle_id", "code_requirement", "path"]],
  ["windows", ["aumid", "package_family", "executable"]],
  ["linux", ["desktop_entry", "executable"]],
]);
const DELIVERY_MODES: ReadonlySet<string> = new Set(["foreground", "background"]);

const selectorKey = (selector: ComputerUseAppSelector): string =>
  `${selector.platform}\t${selector.kind}\t${selector.value}`;

export function encodeCanonicalPolicy(policy: ComputerUsePolicyBody): CanonicalPolicy {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(policy.revision) || BigInt(policy.revision) > U64_MAX) {
    return { ok: false, refusal: "invalid_revision" };
  }
  if (
    !within(
      policy.checkInIntervalMs,
      COMPUTER_USE_CHECK_IN_INTERVAL_MS_MIN,
      COMPUTER_USE_CHECK_IN_INTERVAL_MS_MAX,
    ) ||
    !within(
      policy.actionTimeoutMs,
      COMPUTER_USE_ACTION_TIMEOUT_MS_MIN,
      COMPUTER_USE_ACTION_TIMEOUT_MS_MAX,
    )
  ) {
    return { ok: false, refusal: "out_of_range" };
  }
  if (
    !POLICY_ID.test(policy.authorityId) ||
    !DELIVERY_MODES.has(policy.defaultDeliveryMode) ||
    policy.disallowedApps.some(
      ({ platform, kind, value }) =>
        !SELECTOR_KINDS.get(platform)?.includes(kind) ||
        value.length === 0 ||
        FRAMING_CONTROL.test(value) ||
        LONE_SURROGATE.test(value),
    )
  ) {
    return { ok: false, refusal: "invalid_text" };
  }
  const keyed = policy.disallowedApps.map((selector) => {
    const key = selectorKey(selector);
    return { key, bytes: encoder.encode(key) };
  });
  keyed.sort((left, right) => compareUtf8(left.bytes, right.bytes));
  for (let index = 1; index < keyed.length; index += 1) {
    if (compareUtf8(keyed[index - 1]!.bytes, keyed[index]!.bytes) === 0) {
      return { ok: false, refusal: "duplicate_selector" };
    }
  }
  const lines = [
    COMPUTER_USE_POLICY_FORMAT,
    `authority=${policy.authorityId}`,
    `revision=${policy.revision}`,
    `enabled=${policy.enabled ? 1 : 0}`,
    `delivery=${policy.defaultDeliveryMode}`,
    `check_in_ms=${policy.checkInIntervalMs}`,
    `action_timeout_ms=${policy.actionTimeoutMs}`,
    `diagnostics=${policy.diagnosticMetadataEnabled ? 1 : 0}`,
    `disallowed=${keyed.length}`,
    ...keyed.map(({ key }) => `app=${key}`),
  ];
  const bytes = encoder.encode(`${lines.join("\n")}\n`);
  if (bytes.length > MAX_CANONICAL_POLICY_BYTES) return { ok: false, refusal: "oversized" };
  return { ok: true, bytes };
}
