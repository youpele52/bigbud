import * as Effect from "effect/Effect";
import type { ServerSettingsShape } from "../ws/serverSettings.ts";
import type { makeThreadOrganizationRuntimeRepository } from "../persistence/Layers/ThreadOrganizationRuntime.ts";
import type { OrganizationRuntimePolicy } from "../persistence/Services/ThreadOrganizationRuntime.ts";
import { reconcileOrganizationPolicy } from "./organizationBridge.startup.ts";
import type { OrganizationOwner } from "./organizationOwner.ts";
import { organizationPolicySettings, organizationWirePolicy } from "./organizationPolicy.ts";
import type { OrganizationFrame } from "./organizationProtocol.ts";

type Runtime = Effect.Success<typeof makeThreadOrganizationRuntimeRepository>;

/** Short-rule startup/policy barrier used by final acceptance; mirrors Rust's restart wait. */
export function organizationIdleNotBefore(
  launchedAtMs: number,
  stored: OrganizationRuntimePolicy,
  idleTimeoutMs: number,
) {
  return Math.max(launchedAtMs, stored.shortPolicyChangedAtMs ?? 0) + idleTimeoutMs;
}

/** Fallback re-read of the stored barrier when no post-commit hint arrived. */
export const ORGANIZATION_POLICY_FALLBACK_MS = 30_000;

/** Applies settings and Undo/target barrier changes in place through a `policy` frame instead
 * of a full resnapshot. The DB barrier is committed first; acceptance switches to the new
 * policy before Rust does, so a proposal under the old version is refused as stale, never
 * accepted against a policy Rust did not use. Changes during an in-flight proposal wait.
 * Each step compares the in-memory settings fingerprint; the stored barrier is read only after
 * a post-commit deliberate organisation update (`markBarrier`, e.g. Undo) or the fallback.
 */
export function makeOrganizationPolicyFollower(input: {
  runtime: Runtime;
  settings: ServerSettingsShape;
  classification: "new" | "existing";
  owner: OrganizationOwner;
  launchedAtMs: number;
  proposalInFlight: () => boolean;
  send: (frame: OrganizationFrame) => Effect.Effect<void, Error>;
  onGrace: (graceMs: number) => void;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const { owner } = input;
  let barrierHint = false;
  let fallbackAt = now() + ORGANIZATION_POLICY_FALLBACK_MS;
  const step = Effect.gen(function* () {
    const latest = yield* input.settings.getSettings;
    const fingerprintChanged =
      organizationPolicySettings(latest, input.classification).policyFingerprint !==
      owner.policy.fingerprint;
    const at = now();
    if (!fingerprintChanged && !barrierHint && at < fallbackAt) return;
    if (input.proposalInFlight()) return;
    barrierHint = false;
    fallbackAt = at + ORGANIZATION_POLICY_FALLBACK_MS;
    const stored = yield* input.runtime.readPolicy();
    const barrierChanged =
      (stored.targetDrainNotBeforeMs ?? 0) !== (owner.policy.scheduling?.targetNotBeforeMs ?? 0);
    if (!fingerprintChanged && !barrierChanged) return;
    const next = fingerprintChanged
      ? yield* reconcileOrganizationPolicy(input.runtime, latest, input.classification, at)
      : { stored, wire: organizationWirePolicy(latest, input.classification, stored) };
    owner.policy = next.wire;
    owner.idleNotBeforeMs = organizationIdleNotBefore(
      input.launchedAtMs,
      next.stored,
      latest.inyosiraIdleTimeoutMinutes * 60000,
    );
    input.onGrace(latest.inyosiraGraceMinutes * 60000);
    yield* input.send({
      backendNonce: owner.backendNonce,
      generation: owner.generation,
      type: "policy",
      value: next.wire,
    });
  });
  return {
    step,
    markBarrier: () => {
      barrierHint = true;
    },
  };
}
