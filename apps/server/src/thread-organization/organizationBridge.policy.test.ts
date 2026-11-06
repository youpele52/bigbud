import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@bigbud/contracts/core/settings.ts";
import * as Effect from "effect/Effect";
import type { OrganizationRuntimePolicy } from "../persistence/Services/ThreadOrganizationRuntime.ts";
import {
  makeOrganizationPolicyFollower,
  ORGANIZATION_POLICY_FALLBACK_MS,
} from "./organizationBridge.policy.ts";
import type { OrganizationOwner } from "./organizationOwner.ts";
import { organizationPolicySettings, organizationWirePolicy } from "./organizationPolicy.ts";
import type { OrganizationFrame } from "./organizationProtocol.ts";

type Input = Parameters<typeof makeOrganizationPolicyFollower>[0];
const stored = (version: number, barrier: number | null): OrganizationRuntimePolicy =>
  ({
    policyVersion: version,
    shortPolicyChangedAtMs: null,
    olderPolicyChangedAtMs: null,
    targetDrainNotBeforeMs: barrier,
  }) as OrganizationRuntimePolicy;

it.effect("barrier and settings changes become in-place policy frames, never mid-proposal", () =>
  Effect.gen(function* () {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    let policy = stored(1, null);
    let reconciles = 0;
    let inFlight = false;
    let reads = 0;
    let clock = 1000;
    const sent: OrganizationFrame[] = [];
    const owner: OrganizationOwner = {
      backendNonce: "owner",
      generation: 1,
      active: true,
      observedAtMs: 0,
      policy: organizationWirePolicy(settings, "existing", policy),
      idleNotBeforeMs: 0,
      rows: new Map(),
    };
    const runtime = {
      readPolicy: () =>
        Effect.sync(() => {
          reads += 1;
          return policy;
        }),
      reconcilePolicy: () =>
        Effect.sync(() => {
          reconciles += 1;
          policy = stored(policy.policyVersion + 1, policy.targetDrainNotBeforeMs);
          return { status: "applied" as const, policy };
        }),
    } as unknown as Input["runtime"];
    const grace: number[] = [];
    const follower = makeOrganizationPolicyFollower({
      runtime,
      settings: { getSettings: Effect.sync(() => settings) } as unknown as Input["settings"],
      classification: "existing",
      owner,
      launchedAtMs: 0,
      proposalInFlight: () => inFlight,
      send: (frame) => Effect.sync(() => void sent.push(frame)),
      onGrace: (value) => void grace.push(value),
      now: () => clock,
    });
    const follow = follower.step;
    yield* follow;
    assert.equal(sent.length, 0);
    // Without a hint or a settings change the stored policy is not read every second.
    assert.equal(reads, 0);
    // Undo advanced the drain barrier: same version, barrier only.
    policy = stored(1, 50_000);
    follower.markBarrier();
    inFlight = true;
    yield* follow;
    assert.equal(sent.length, 0);
    assert.equal(reads, 0);
    inFlight = false;
    yield* follow;
    assert.equal(reads, 1);
    assert.equal(reconciles, 0);
    assert.deepEqual(sent.at(-1), {
      backendNonce: "owner",
      generation: 1,
      type: "policy",
      value: owner.policy,
    });
    assert.equal(owner.policy.version, 1);
    assert.equal(owner.policy.scheduling?.targetNotBeforeMs, 50_000);
    // A settings change reconciles a new version first, then publishes it.
    settings = { ...settings, inyosiraGraceMinutes: 7 };
    yield* follow;
    assert.equal(reconciles, 1);
    assert.equal(owner.policy.version, 2);
    assert.equal(
      owner.policy.fingerprint,
      organizationPolicySettings(settings, "existing").policyFingerprint,
    );
    assert.deepEqual(grace.at(-1), 7 * 60000);
    assert.equal(sent.length, 2);
    yield* follow;
    assert.equal(sent.length, 2);
    // A barrier committed without a delivered hint is still found by the fallback read.
    policy = stored(policy.policyVersion, 90_000);
    const before = reads;
    clock += ORGANIZATION_POLICY_FALLBACK_MS - 1;
    yield* follow;
    assert.equal(reads, before);
    clock += 1;
    yield* follow;
    assert.equal(reads, before + 1);
    assert.equal(sent.length, 3);
    assert.equal(owner.policy.scheduling?.targetNotBeforeMs, 90_000);
  }),
);
