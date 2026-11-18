import * as Schema from "effect/Schema";
import { RemoteBackendAuthorityId } from "@bigbud/contracts/server/remoteBackendHandshake.ts";
import { MobileActivationRequestId } from "../remote-agent/mobileGatewayActivation.selection.schema.ts";
import {
  MobileGatewayConfiguration,
  validateMobileGatewayConfiguration,
} from "../remote-agent/mobileGatewayLifecycle.schema.ts";
import { MOBILE_RUNTIME_REPAIR_REASONS } from "./mobileGatewayAssets.orphan.reasons.ts";
import { MOBILE_ACTIVATION_REASONS } from "./mobileGatewayActivation.reason.ts";
import { MOBILE_NATIVE_RESOLVE_REASONS } from "./mobileGatewayNative.resolve.ts";
import { MOBILE_STAGE_RETIREMENT_REASONS } from "../remote-agent/mobileStageRetirement.rules.ts";

/** Owner-client UDS only, sibling of the pairing route; same bearer/revision authentication. */
export const MOBILE_OWNER_ACTIVATION_PATH = "/api/remote-backend/mobile/owner";
export const MOBILE_OWNER_ACTIVATION_MAX_BYTES = 16 * 1024;
/** Sent only when the owner passed `--confirm-consent`; anything else is refused before IO. */
export const MOBILE_CONSENT_CONFIRMATION = "grant-durable-mobile-consent";

const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status"), authorityId: RemoteBackendAuthorityId }),
  Schema.Struct({
    action: Schema.Literal("consent-enable"),
    authorityId: RemoteBackendAuthorityId,
    confirmation: Schema.Literal(MOBILE_CONSENT_CONFIRMATION),
    /** CAS on the revision the owner observed in `status`. */
    expectedRevision: Revision,
  }),
  Schema.Struct({
    action: Schema.Literal("activate"),
    authorityId: RemoteBackendAuthorityId,
    requestId: MobileActivationRequestId,
    configuration: MobileGatewayConfiguration,
  }),
  Schema.Struct({ action: Schema.Literal("stop"), authorityId: RemoteBackendAuthorityId }),
  /**
   * Orphan runtime-asset GC: removes only journal-proven unowned trees, reports the rest. With
   * `resolve`, first settles attempted native rows whose supervisor epoch provably ended.
   */
  Schema.Struct({
    action: Schema.Literal("repair"),
    authorityId: RemoteBackendAuthorityId,
    resolve: Schema.optionalKey(Schema.Literal(true)),
  }),
]);
export type MobileOwnerActivationRequest = typeof Request.Type;
export function decodeMobileOwnerActivationRequest(value: unknown): MobileOwnerActivationRequest {
  const request = Schema.decodeUnknownSync(Request)(value, { onExcessProperty: "error" });
  if (request.action === "activate") validateMobileGatewayConfiguration(request.configuration);
  return request;
}

const Reason = Schema.Literals(MOBILE_ACTIVATION_REASONS);
const ErrorName = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/));
const Outcome = Schema.Struct({
  kind: Schema.String.check(Schema.isMaxLength(64)),
  repairRequired: Schema.Boolean,
  at: Schema.String.check(Schema.isMaxLength(64)),
  reason: Schema.NullOr(Reason),
  detail: Schema.NullOr(ErrorName),
});
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1024 }));
const RepairSummary = Schema.Struct({
  at: Schema.String.check(Schema.isMaxLength(64)),
  removed: Count,
  kept: Count,
  failed: Schema.Boolean,
});
export const MobileOwnerStatus = Schema.Struct({
  authorityId: RemoteBackendAuthorityId,
  controller: Schema.Struct({
    attached: Schema.Boolean,
    retiring: Schema.Boolean,
    stopping: Schema.Boolean,
    phase: Schema.NullOr(
      Schema.Literals(["idle", "running", "uncertain-detached", "uncertain-repair"]),
    ),
    lastOutcome: Schema.NullOr(Outcome),
    lastRepair: Schema.NullOr(RepairSummary),
  }),
  consent: Schema.Struct({
    state: Schema.Literals(["enabled", "disabled", "unavailable"]),
    revision: Schema.NullOr(Revision),
  }),
  inputs: Schema.Struct({
    state: Schema.Literals(["loaded", "absent", "invalid", "unsupported"]),
    reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  }),
  settingsEnabled: Schema.Boolean,
});
export type MobileOwnerStatus = typeof MobileOwnerStatus.Type;
export const MobileOwnerConsentResult = Schema.Struct({
  enabled: Schema.Literal(true),
  revision: Revision,
  changed: Schema.Boolean,
  /** The grant also turned settings mobile access on, so the startup guard keeps the grant. */
  settingsEnabled: Schema.Literal(true),
});
export const MobileOwnerActivateResult = Schema.Struct({
  requestId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  status: Schema.Literals(["disabled", "accepted", "selected", "retired", "unavailable", "failed"]),
  /** Only with `failed`: the step that failed before native Start. */
  reason: Schema.optionalKey(Reason),
});
export const MobileOwnerStopResult = Schema.Struct({ stopped: Schema.Literal(true) });
export const MobileOwnerRepairResult = Schema.Struct({
  removed: Count,
  kept: Count,
  entries: Schema.Array(
    Schema.Struct({
      generation: Schema.String.check(Schema.isPattern(/^(?:assets-[a-f0-9]{32}|unknown)$/)),
      outcome: Schema.Literals(["removed", "kept"]),
      reason: Schema.Literals(MOBILE_RUNTIME_REPAIR_REASONS),
    }),
  ).check(Schema.isMaxLength(512)),
  /** Stage retirement after the GC; `null` when it could not run (activation holds the lease). */
  stages: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        retired: Count,
        kept: Count,
        live: Count,
        entries: Schema.Array(
          Schema.Struct({
            stageId: Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/)),
            outcome: Schema.Literals(["retired", "kept"]),
            reason: Schema.Literals(MOBILE_STAGE_RETIREMENT_REASONS),
          }),
        ).check(Schema.isMaxLength(64)),
      }),
    ),
  ),
});
export type MobileOwnerRepairResult = typeof MobileOwnerRepairResult.Type;
export const MobileOwnerResolveResult = Schema.Struct({
  cleared: Count,
  kept: Count,
  unresolved: Count,
  entries: Schema.Array(
    Schema.Struct({
      generation: Schema.String.check(Schema.isPattern(/^assets-[a-f0-9]{32}$/)),
      outcome: Schema.Literals(["cleared", "kept"]),
      reason: Schema.Literals(MOBILE_NATIVE_RESOLVE_REASONS),
    }),
  ).check(Schema.isMaxLength(64)),
  repair: Schema.NullOr(MobileOwnerRepairResult),
});
export type MobileOwnerResolveResult = typeof MobileOwnerResolveResult.Type;

/** Fixed refusal codes; clients map them to their own text and never echo server prose. */
export const MobileOwnerRefusalCode = Schema.Literals([
  "invalid-request",
  "authority-mismatch",
  "unavailable",
  "stale-revision",
  "not-installed",
  "uncertain",
]);
export type MobileOwnerRefusalCode = typeof MobileOwnerRefusalCode.Type;
export const MobileOwnerRefusal = Schema.Struct({ refused: MobileOwnerRefusalCode });

export const mobileOwnerRefusalStatus: Record<MobileOwnerRefusalCode, number> = {
  "invalid-request": 400,
  "authority-mismatch": 409,
  unavailable: 503,
  "stale-revision": 409,
  "not-installed": 409,
  uncertain: 409,
};
