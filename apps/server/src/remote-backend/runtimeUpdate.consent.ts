/**
 * D9 interruption consent (WP-4C). Consent names the affected work: it is bound to the operation
 * id plus a digest of the affected-work list the client was shown, and is consumed at most once.
 * Setup authority, an update request or `interrupt: true` never imply it.
 */
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import type {
  RemoteRuntimeUpdateAffectedWork,
  RemoteRuntimeUpdateErrorCode,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";
import type {
  RemoteRuntimeUpdateOperationsShape,
  RemoteRuntimeUpdatePatch,
  RemoteRuntimeUpdateRecord,
} from "../persistence/Services/RemoteRuntimeUpdateOperations.ts";
import {
  CONSENTABLE_RUNTIME_UPDATE_STATES,
  isTerminalRuntimeUpdateState,
  runtimeUpdateError,
} from "./runtimeUpdate.states.ts";

const CONSENT_DOMAIN = "bigbud.remote-runtime-update.interruption-consent.v1";

/** Order-independent digest of the affected work, bound to one operation id. */
export function runtimeUpdateAffectedWorkDigest(
  operationId: string,
  work: ReadonlyArray<RemoteRuntimeUpdateAffectedWork>,
): string {
  const canonical = work
    .map((item) => [item.kind, item.id, item.label] as const)
    .toSorted((a, b) => (a[0] + "\0" + a[1] < b[0] + "\0" + b[1] ? -1 : 1));
  return createHash("sha256")
    .update(JSON.stringify([CONSENT_DOMAIN, operationId, canonical]))
    .digest("hex");
}

type Decision =
  | { readonly ok: true; readonly patch: Omit<RemoteRuntimeUpdatePatch, "updatedAt"> | null }
  | { readonly ok: false; readonly code: RemoteRuntimeUpdateErrorCode; readonly message: string };

const reject = (code: RemoteRuntimeUpdateErrorCode, message: string): Decision => ({
  ok: false,
  code,
  message,
});

/** Pure rule for recording consent; `patch: null` is an idempotent repeat of the same consent. */
export function decideInterruptionConsent(
  record: RemoteRuntimeUpdateRecord | undefined,
  suppliedDigest: string,
  currentDigest: string,
): Decision {
  if (!record || isTerminalRuntimeUpdateState(record.state))
    return reject("consent-stale", "The update operation this consent names is no longer current.");
  if (record.consentState === "consumed")
    return reject("consent-reused", "Interruption consent for this update was already used.");
  if (!record.interruptRequested)
    return reject(
      "invalid-state",
      "Request an interrupting update before confirming interruption.",
    );
  if (!CONSENTABLE_RUNTIME_UPDATE_STATES.includes(record.state))
    return reject("invalid-state", "Interruption consent is accepted once the update is staged.");
  if (suppliedDigest !== currentDigest)
    return reject("consent-stale", "The affected work changed; review it and confirm again.");
  if (record.consentState === "recorded" && record.consentDigest === currentDigest)
    return { ok: true, patch: null };
  return { ok: true, patch: { consentState: "recorded", consentDigest: currentDigest } };
}

/** Pure rule for consuming consent at activation (WP-4D). */
export function decideConsentConsumption(
  record: RemoteRuntimeUpdateRecord | undefined,
  currentDigest: string,
): Decision {
  if (!record || isTerminalRuntimeUpdateState(record.state))
    return reject("consent-stale", "The update operation is no longer current.");
  if (record.consentState === "consumed")
    return reject("consent-reused", "Interruption consent for this update was already used.");
  if (record.consentState !== "recorded")
    return reject("consent-required", "Interrupting live work needs separate consent.");
  if (record.consentDigest !== currentDigest)
    return reject("consent-stale", "The affected work changed after consent was given.");
  return { ok: true, patch: { consentState: "consumed" } };
}

interface ConsentDeps {
  readonly repository: RemoteRuntimeUpdateOperationsShape;
  readonly affectedWork: (
    record: RemoteRuntimeUpdateRecord,
  ) => Effect.Effect<ReadonlyArray<RemoteRuntimeUpdateAffectedWork>>;
  readonly now: () => string;
}

const applyDecision = Effect.fn("RemoteRuntimeUpdate.applyConsentDecision")(function* (
  deps: ConsentDeps,
  record: RemoteRuntimeUpdateRecord | undefined,
  decision: Decision,
) {
  if (!decision.ok) return yield* runtimeUpdateError(decision.code, decision.message);
  if (!record) return yield* runtimeUpdateError("consent-stale", "The update is not current.");
  if (decision.patch === null) return record;
  const updated = yield* deps.repository
    .compareAndSet(
      record.operationId,
      { states: [record.state], consentState: record.consentState },
      { ...decision.patch, updatedAt: deps.now() },
    )
    .pipe(Effect.mapError(() => runtimeUpdateError("unavailable", "Update state is unavailable.")));
  // Lost a race with another consent, consumption or transition: the caller must re-read.
  if (!updated)
    return yield* runtimeUpdateError("consent-stale", "The update changed; review it again.");
  return updated;
});

const load = (deps: ConsentDeps, operationId: string) =>
  deps.repository
    .get(operationId)
    .pipe(Effect.mapError(() => runtimeUpdateError("unavailable", "Update state is unavailable.")));

const digestFor = Effect.fn("RemoteRuntimeUpdate.currentConsentDigest")(function* (
  deps: ConsentDeps,
  record: RemoteRuntimeUpdateRecord,
) {
  return runtimeUpdateAffectedWorkDigest(record.operationId, yield* deps.affectedWork(record));
});

export const recordInterruptionConsent = Effect.fn("RemoteRuntimeUpdate.recordConsent")(function* (
  deps: ConsentDeps,
  operationId: string,
  suppliedDigest: string,
) {
  const record = yield* load(deps, operationId);
  const current = record ? yield* digestFor(deps, record) : "";
  return yield* applyDecision(
    deps,
    record,
    decideInterruptionConsent(record, suppliedDigest, current),
  );
});

/** Single use: a second call, or a call after the affected work changed, is rejected. */
export const consumeInterruptionConsent = Effect.fn("RemoteRuntimeUpdate.consumeConsent")(
  function* (deps: ConsentDeps, operationId: string) {
    const record = yield* load(deps, operationId);
    const current = record ? yield* digestFor(deps, record) : "";
    return yield* applyDecision(deps, record, decideConsentConsumption(record, current));
  },
);
