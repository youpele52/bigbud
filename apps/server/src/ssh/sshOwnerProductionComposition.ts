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
} from "./sshOwnerProductionBoot.ts";
import { readSshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";
import {
  startProductionOwnerForBoot,
  type SshOwnerProductionHandle,
} from "./sshOwnerProductionClient.ts";
import type { SshOwnerProductionProfile } from "./sshOwnerProductionClient.launch.ts";
import { toSshOwnerUnavailable } from "./sshOwnerProductionClient.errors.ts";
import {
  deriveSshOwnerProfileBinding,
  SshOwnerProfileError,
  type SshOwnerProfileBinding,
} from "./sshOwnerProductionProfile.ts";
import { isSshOwnerDevFixtureSelected } from "./sshOwnerSelection.ts";
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
 * 2. Supply the trusted endpoint facts (`ownerProfile`) for the active profile
 *    when calling `configureSshOwner`; the profile **binding** itself is always
 *    derived from `config.stateDir` and the resolved artifact profile and can
 *    never be overridden by the caller or the environment.
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
  /**
   * Trusted endpoint facts for the native owner client. The profile binding is
   * always derived from `config.stateDir` and the resolved artifact profile; a
   * caller can never supply or override it.
   */
  readonly ownerProfile?: SshOwnerProductionProfile;
  /** Test-only artifact override; production always resolves and verifies. */
  readonly artifactOverride?: SshOwnerArtifact;
}

interface LaunchProfile {
  readonly endpoint?: SshOwnerProductionProfile;
  readonly binding: SshOwnerProfileBinding;
}

let configuration: SshOwnerProductionConfiguration = { kind: "inactive" };
let admission: SshOwnerAdmission = { kind: "inactive" };
let launchProfile: LaunchProfile | undefined;

export const readSshOwnerProductionConfiguration = () => configuration;
export const readSshOwnerAdmission = () => admission;

/** Test-only reset; production code never clears a live admission. */
export function resetSshOwnerProductionStateForTest(): void {
  configuration = { kind: "inactive" };
  admission = { kind: "inactive" };
  launchProfile = undefined;
}

/**
 * Production sibling of `configureDevSshOwner`. It resolves the packaged owner
 * for the active profile and records the result. It never throws: a missing or
 * unverified artifact becomes a typed `sshOwnerUnavailable` so the server can
 * keep local features running with SSH closed.
 */
export const configureSshOwner = Effect.fn("configureSshOwner")(function* (
  config: Pick<ServerConfigShape, "mode" | "devUrl" | "stateDir">,
  entryUrl: string = import.meta.url,
  options: ConfigureSshOwnerOptions = {},
) {
  const activated = options.activation ?? SSH_OWNER_PRODUCTION_ACTIVATION;
  if (!activated) {
    configuration = { kind: "inactive" };
    admission = { kind: "inactive" };
    launchProfile = undefined;
    return configuration;
  }
  const resolution = yield* resolveArtifact(config, entryUrl, options);
  if (resolution.kind === "unavailable") {
    configuration = { kind: "unavailable", error: resolution.error };
    admission = { kind: "closed", step: "configuration", error: resolution.error };
    launchProfile = undefined;
    return configuration;
  }
  const environment = options.environment ?? process.env;
  const binding = yield* Effect.try({
    try: () =>
      deriveSshOwnerProfileBinding({
        kind: resolution.artifact.profile,
        stateDirectory: config.stateDir,
        environment,
        devFixtureGate: isSshOwnerDevFixtureSelected(),
      }),
    catch: (cause) =>
      cause instanceof SshOwnerProfileError
        ? cause
        : new SshOwnerProfileError(
            "owner-profile-unavailable",
            "The SSH owner profile binding could not be derived.",
            cause,
          ),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        new SshOwnerUnavailableError({
          code: "sshOwnerUnavailable",
          reason: error.reason,
          message: error.message,
        }),
      ),
    ),
  );
  if (binding instanceof SshOwnerUnavailableError) {
    configuration = { kind: "unavailable", error: binding };
    admission = { kind: "closed", step: "configuration", error: binding };
    launchProfile = undefined;
    return configuration;
  }
  launchProfile = {
    ...(options.ownerProfile === undefined
      ? {}
      : { endpoint: { ...options.ownerProfile, kind: resolution.artifact.profile } }),
    binding,
  };
  configuration = { kind: "configured", artifact: resolution.artifact };
  return configuration;
});

function resolveArtifact(
  config: Pick<ServerConfigShape, "mode" | "devUrl" | "stateDir">,
  entryUrl: string,
  options: ConfigureSshOwnerOptions,
) {
  if (options.artifactOverride)
    return Effect.succeed({ kind: "resolved" as const, artifact: options.artifactOverride });
  return resolveSshOwnerArtifact({
    config,
    entryUrl,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.arch ? { arch: options.arch } : {}),
    ...(options.trustedManifestEntry ? { trustedManifestEntry: options.trustedManifestEntry } : {}),
  });
}

function startProductionOwner(
  artifact: SshOwnerArtifact,
  sql: SqlClient.SqlClient,
  launch: LaunchProfile | undefined,
): Effect.Effect<SshOwnerProductionHandle, SshOwnerUnavailableError> {
  if (!launch?.endpoint) {
    return Effect.fail(
      new SshOwnerUnavailableError({
        code: "sshOwnerUnavailable",
        reason: "owner-profile-unavailable",
        message: `The verified ${artifact.profile} SSH owner has no trusted endpoint profile; SSH stays unavailable and local work continues.`,
      }),
    );
  }
  return startProductionOwnerForBoot({
    artifact,
    profile: launch.endpoint,
    binding: launch.binding,
    sql,
  }).pipe(Effect.mapError((error) => toSshOwnerUnavailable(error, artifact.profile)));
}

/** Test-only boot probe: starts the owner from the last trusted configuration. */
export const startSshOwnerAfterConfigurationForTest = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    if (configuration.kind !== "configured") {
      return yield* Effect.fail(
        new SshOwnerUnavailableError({
          code: "sshOwnerUnavailable",
          reason: "owner-profile-unavailable",
          message: "No verified SSH owner configuration is available.",
        }),
      );
    }
    return yield* startProductionOwner(configuration.artifact, sql, launchProfile);
  });

/** Owner death after admission is typed-closed; it never falls back to legacy. */
export function closeSshOwnerAdmissionOnOwnerDeath(): void {
  admission = {
    kind: "closed",
    step: "owner-attach",
    error: new SshOwnerUnavailableError({
      code: "sshOwnerUnavailable",
      reason: "owner-died",
      message:
        "The SSH owner exited after admission; SSH stays closed and there is no legacy fallback.",
    }),
  };
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
      startOrAttachOwner: startProductionOwner(configured.artifact, sql, launchProfile),
      hydrate: (owner) =>
        readSshOwnerHydrationSnapshot(sql, config.stateDir).pipe(
          Effect.flatMap((snapshot) => owner.hydrate(snapshot)),
        ),
      openAdmission: () => Effect.void,
    });
    recordOutcome(outcome);
    if (outcome.kind === "open") {
      const owner = outcome.owner as SshOwnerProductionHandle;
      owner.onDeath?.(closeSshOwnerAdmissionOnOwnerDeath);
      yield* Effect.addFinalizer(() => owner.shutdown?.() ?? Effect.void);
    }
    if (outcome.kind === "unavailable")
      yield* Effect.logWarning("SSH admission stayed closed", {
        step: outcome.step,
        reason: outcome.error.reason,
      });
  }),
);
