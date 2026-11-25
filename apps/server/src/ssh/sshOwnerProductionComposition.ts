import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";

import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig, type ServerConfigShape } from "../startup/config.ts";
import {
  resolveSshOwnerArtifact,
  type SshOwnerArtifact,
  type SshOwnerProfile,
} from "./sshOwnerProductionArtifact.ts";
import {
  runSshOwnerBootSequence,
  type SshOwnerBootOutcome,
  type SshOwnerBootStep,
  type SshOwnerProductionOwner,
} from "./sshOwnerProductionBoot.ts";
import { readSshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";
import {
  readSshOwnerStartupState,
  SshOwnerUnavailableError,
  type LegacyEntryFencedError,
} from "./sshOwnerStartupRefusal.ts";
import type { TrustedStandaloneSshOwnerManifestEntry } from "./sshOwnerExecutable.ts";

/**
 * Production SSH-owner composition (W3.7), reviewable but **not activated on
 * this branch**. `SSH_OWNER_PRODUCTION_ACTIVATION` is off, so this module is
 * inert and today's dev/legacy behaviour is unchanged.
 *
 * ## What W7 changes
 *
 * 1. Flip `SSH_OWNER_PRODUCTION_ACTIVATION` in
 *    `packages/shared/src/SshOwnerActivation.ts` to `true`.
 * 2. Replace `startProductionOwner` with the composed native owner client
 *    (the W2 provider/terminal/workspace tracks) so `start or attach` returns a
 *    real owner handle instead of the typed `owner-client-not-composed` result.
 * 3. Delete cutover inventory rows 1–51, the D1–D5 type dependents, the dev
 *    fixture selector (`sshOwnerDevMode.fixture.ts`) and every remaining
 *    `sshOwnerSelection.ts` fence call site that guards deleted legacy code.
 * 4. Run the structural checker on the changed files and the `cutover/` B
 *    traces, expecting zero outside-owner launches.
 * 5. Record the S4 acceptance (protocol version, capabilities, typed errors,
 *    grants/limits and artifact IDs).
 *
 * The boot order is already the designed one: lock → retirement marker →
 * owner attach → hydration → admission. Any failure keeps SSH admission
 * closed with a typed reason while local features keep working.
 *
 * @module sshOwnerProductionComposition
 */

export type SshOwnerProductionConfiguration =
  | { readonly kind: "inactive" }
  | { readonly kind: "unavailable"; readonly error: SshOwnerUnavailableError }
  | { readonly kind: "configured"; readonly artifact: SshOwnerArtifact };

export type SshOwnerAdmission =
  | { readonly kind: "inactive" }
  | {
      readonly kind: "open";
      readonly profile: SshOwnerProfile;
      readonly artifactPath: string;
    }
  | {
      readonly kind: "closed";
      readonly step: SshOwnerBootStep | "configuration";
      readonly error: LegacyEntryFencedError | SshOwnerUnavailableError;
    };

export interface ConfigureSshOwnerOptions {
  readonly activation?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly trustedManifestEntry?: TrustedStandaloneSshOwnerManifestEntry;
}

let configuration: SshOwnerProductionConfiguration = { kind: "inactive" };
let admission: SshOwnerAdmission = { kind: "inactive" };

export const readSshOwnerProductionConfiguration = () => configuration;
export const readSshOwnerAdmission = () => admission;

/** Test-only reset; production code never clears a live admission. */
export function resetSshOwnerProductionStateForTest(): void {
  configuration = { kind: "inactive" };
  admission = { kind: "inactive" };
}

/**
 * Production sibling of `configureDevSshOwner`. It resolves the packaged owner
 * for the active profile and records the result. It never throws: a missing or
 * unverified artifact becomes a typed `sshOwnerUnavailable` so the server can
 * keep local features running with SSH closed.
 */
export const configureSshOwner = Effect.fn("configureSshOwner")(function* (
  config: Pick<ServerConfigShape, "mode" | "devUrl">,
  entryUrl: string = import.meta.url,
  options: ConfigureSshOwnerOptions = {},
) {
  const activated = options.activation ?? SSH_OWNER_PRODUCTION_ACTIVATION;
  if (!activated) {
    configuration = { kind: "inactive" };
    admission = { kind: "inactive" };
    return configuration;
  }
  const resolution = yield* resolveSshOwnerArtifact({
    config,
    entryUrl,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.trustedManifestEntry ? { trustedManifestEntry: options.trustedManifestEntry } : {}),
  });
  if (resolution.kind === "unavailable") {
    configuration = { kind: "unavailable", error: resolution.error };
    admission = { kind: "closed", step: "configuration", error: resolution.error };
    return configuration;
  }
  configuration = { kind: "configured", artifact: resolution.artifact };
  return configuration;
});

function startProductionOwner(
  artifact: SshOwnerArtifact,
): Effect.Effect<SshOwnerProductionOwner, SshOwnerUnavailableError> {
  return Effect.fail(
    new SshOwnerUnavailableError({
      code: "sshOwnerUnavailable",
      reason: "owner-client-not-composed",
      message: `The verified ${artifact.profile} SSH owner at ${artifact.path} has no composed native client yet; SSH stays unavailable and local work continues.`,
    }),
  );
}

function recordOutcome(outcome: SshOwnerBootOutcome): void {
  if (outcome.kind === "open") {
    admission = {
      kind: "open",
      profile: outcome.owner.profile,
      artifactPath: outcome.owner.artifactPath,
    };
    return;
  }
  admission =
    outcome.kind === "refused"
      ? { kind: "closed", step: "retirement-marker", error: outcome.error }
      : { kind: "closed", step: outcome.step, error: outcome.error };
}

/**
 * Runs the designed boot order after the state lock and persistence exist.
 * Inert while the activation constant is off.
 */
export const SshOwnerProductionBootLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!SSH_OWNER_PRODUCTION_ACTIVATION) return;
    const config = yield* ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const instance = yield* BackendInstance;
    const configured = configuration;
    if (configured.kind === "inactive") {
      admission = { kind: "inactive" };
      return;
    }
    if (configured.kind === "unavailable") {
      admission = { kind: "closed", step: "configuration", error: configured.error };
      return;
    }
    const outcome = yield* runSshOwnerBootSequence({
      acquireStateLock: Effect.tryPromise({
        try: () => instance.assertHeld(),
        catch: () =>
          new SshOwnerUnavailableError({
            code: "sshOwnerUnavailable",
            reason: "state-lock-failed",
            message: "The backend state lock is no longer held; SSH admission stayed closed.",
          }),
      }),
      readState: readSshOwnerStartupState(sql, {
        profileScope: config.stateDir,
        ownerPresent: Effect.succeed(true),
      }),
      startOrAttachOwner: startProductionOwner(configured.artifact),
      hydrate: (owner) =>
        readSshOwnerHydrationSnapshot(sql, config.stateDir).pipe(
          Effect.flatMap((snapshot) => owner.hydrate(snapshot)),
        ),
      openAdmission: () => Effect.void,
    });
    recordOutcome(outcome);
    if (outcome.kind === "unavailable")
      yield* Effect.logWarning("SSH admission stayed closed", {
        step: outcome.step,
        reason: outcome.error.reason,
      });
  }),
);
