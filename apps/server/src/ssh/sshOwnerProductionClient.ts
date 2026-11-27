import * as Effect from "effect/Effect";
import type { OpencodeV2ServiceBinding } from "./sshOwnerRemotePath.ts";
import type { DevOpencodeV2ServiceRefusal } from "./sshOwnerDevRuntime.providerServices.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.types.ts";
import type { SshOwnerArtifact } from "./sshOwnerProductionArtifact.ts";
import { sshOwnerProfileSurvivesLauncher } from "./sshOwnerProfileLifetime.ts";
import type { SshOwnerProductionOwner } from "./sshOwnerProductionBoot.ts";
import type { PickerProofBoundTarget } from "./sshOwnerPickerProof.client.session.types.ts";
import type { SshOwnerTargetDescriptor } from "./sshOwnerProductionClient.launch.ts";
import { SshOwnerClientError, fromPickerProofError } from "./sshOwnerProductionClient.errors.ts";
import { assertSshOwnerHydrationAcknowledged } from "./sshOwnerProductionClient.hydration.ts";
import {
  acquireSshOwnerLaunchGate,
  clearSshOwnerAttachmentDescriptor,
  newSshOwnerAttachCapability,
  readSshOwnerAttachmentDescriptor,
  writeSshOwnerAttachmentDescriptor,
} from "./sshOwnerProductionClient.attachment.ts";
import {
  classifyStartupError,
  resolveSshOwnerLaunchFacts,
  spawnSshOwnerProduction,
  type SshOwnerLaunchFacts,
} from "./sshOwnerProductionClient.launch.ts";
import { negotiateSshOwnerV1, SSH_OWNER_PROTOCOL } from "./sshOwnerProductionClient.negotiate.ts";
import { tryAttachSshOwnerProduction as tryAttach } from "./sshOwnerProductionClient.reattach.ts";
import {
  measureSshOwnerArtifactIdentity,
  waitForSshOwnerSocketGone,
} from "./sshOwnerProductionClient.identity.ts";
import { shutdownSshOwnerForDrain } from "./sshOwnerProductionClient.shutdown.ts";
import type { OwnerShutdownReport } from "./sshOwnerPickerProof.codec.ownerShutdown.ts";
import type { SshOwnerHydrationSnapshot } from "./sshOwnerProductionHydration.ts";

/**
 * Production native owner client (W3.7).
 *
 * One profile has at most one owner: the client first attaches to a live owner
 * named by the profile descriptor (so a backend restart reattaches), and only
 * spawns through an exclusive launch gate when no verified owner exists. The
 * owner's own profile lock is the final authority against a second owner.
 *
 * @module sshOwnerProductionClient
 */

export type SshOwnerOwnerState = "open" | "detached" | "dead";

export interface SshOwnerProductionHandle extends SshOwnerProductionOwner {
  readonly mode: "spawned" | "attached";
  readonly ownerEpoch: Uint8Array;
  readonly targetGeneration: Uint8Array;
  /** Trusted OpenCode v2 executable this owner was launched with, if any. */
  readonly opencodeV2Service?: OpencodeV2ServiceBinding;
  /** Typed settings refusal when the configured v2 binding is unusable. */
  readonly opencodeV2Refusal?: DevOpencodeV2ServiceRefusal;
  readonly state: () => SshOwnerOwnerState;
  /**
   * Binds one target on the shared owner (W3.7). Every request carries the
   * descriptor; grants are bound to that exact target and generation.
   */
  target(descriptor: SshOwnerTargetDescriptor): PickerProofBoundTarget;
  /** U24 owner-wide peer enrollment and relay; no target is bound. */
  readonly peer: PickerProofOwner["peerProduction"];
  /** Detach, or reap a non-surviving profile. Idempotent. */
  shutdown(): Effect.Effect<void>;
  /** Upgrade drain: the owner closes every master and lease, then exits (never re-attached). */
  shutdownForDrain(): Promise<OwnerShutdownReport>;
  onDeath(listener: () => void): () => void;
}

export interface StartSshOwnerProductionInput {
  readonly artifact: SshOwnerArtifact;
  readonly facts: SshOwnerLaunchFacts;
  readonly sql: SqlClient.SqlClient;
  readonly deadlineMs?: number;
  readonly advertisedCapabilities?: ReadonlyArray<string>;
  readonly requiredCapabilities?: ReadonlyArray<string>;
  /** Bound on waiting for a refused owner from another artifact to exit. */
  readonly ownerExitWaitMs?: number;
}

const clientError = (failure: SshOwnerClientError["failure"], message: string, cause?: unknown) =>
  new SshOwnerClientError(failure, message, cause);

const surviving = sshOwnerProfileSurvivesLauncher;

/** Production is per-target only: a single-target owner cannot serve this client. */
const requireMultiTarget = (owner: PickerProofOwner) => {
  if (owner.multiTarget) return owner;
  throw clientError(
    "version-incompatible",
    "The SSH owner pinned one target at startup; production requires per-target admission.",
  );
};

function makeHandle(input: {
  artifact: SshOwnerArtifact;
  facts: SshOwnerLaunchFacts;
  owner: PickerProofOwner;
  mode: "spawned" | "attached";
  releaseGate: () => Promise<void>;
  detachOwner: () => Promise<void>;
  reap: () => Promise<void>;
}): SshOwnerProductionHandle {
  let state: SshOwnerOwnerState = "open";
  const listeners = new Set<() => void>();
  const unsubscribe = input.owner.onLost(() => {
    if (state === "dead") return;
    state = "dead";
    for (const listener of listeners) listener();
  });
  const detach = async () => {
    if (state !== "open") return;
    state = "detached";
    unsubscribe();
    await input.detachOwner().catch(() => undefined);
  };
  const shutdown = Effect.promise(async () => {
    if (surviving(input.artifact.profile)) await detach();
    else {
      state = "detached";
      unsubscribe();
      await input.reap().catch(() => undefined);
    }
    await input.releaseGate();
  });
  const abortHydration = Effect.promise(async () => {
    // An unhydrated owner is never trusted: a spawned child is reaped even when
    // the profile would normally survive; an attached owner is only detached.
    state = "detached";
    unsubscribe();
    await (input.mode === "spawned" ? input.reap() : input.detachOwner()).catch(() => undefined);
    await input.releaseGate();
  });
  return {
    profile: input.artifact.profile,
    artifactPath: input.artifact.path,
    mode: input.mode,
    ownerEpoch: input.owner.ownerEpoch,
    // A target-free production owner has no startup target: read lazily, so a
    // handle exists before any target is bound (and never throws on creation).
    get targetGeneration() {
      return input.owner.targetGeneration;
    },
    ...(input.facts.opencodeV2Service === undefined
      ? {}
      : { opencodeV2Service: input.facts.opencodeV2Service }),
    ...(input.facts.opencodeV2Refusal === undefined
      ? {}
      : { opencodeV2Refusal: input.facts.opencodeV2Refusal }),
    state: () => state,
    target: (descriptor) => input.owner.bindTarget(descriptor),
    peer: input.owner.peerProduction,
    onDeath(listener) {
      if (state === "dead") {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shutdown: () => shutdown,
    async shutdownForDrain() {
      state = "detached";
      unsubscribe();
      try {
        return await shutdownSshOwnerForDrain({
          owner: input.owner,
          socketPath: input.facts.socketPath,
          attachFile: input.facts.attachFile,
        });
      } finally {
        await input.releaseGate();
      }
    },
    abortHydration: () => abortHydration,
    hydrate: (snapshot: SshOwnerHydrationSnapshot) =>
      Effect.try({
        try: () =>
          assertSshOwnerHydrationAcknowledged({
            ...(input.facts.target === undefined ? {} : { targetId: input.facts.target.targetId }),
            snapshot,
            storage: input.owner.hydratedStorage,
            aliasDescriptor: input.owner.aliasDescriptor,
            ...(input.owner.reconciliation === undefined
              ? {}
              : { reconciliation: input.owner.reconciliation }),
            ...(input.owner.acknowledgedSnapshot === undefined
              ? {}
              : { acknowledgedSnapshot: input.owner.acknowledgedSnapshot }),
          }),
        catch: (cause) =>
          cause instanceof SshOwnerClientError
            ? cause
            : clientError("hydration-failed", "SSH owner hydration failed.", cause),
      }),
  };
}

function negotiate(
  owner: PickerProofOwner,
  input: Pick<StartSshOwnerProductionInput, "advertisedCapabilities" | "requiredCapabilities">,
) {
  return negotiateSshOwnerV1({
    major: SSH_OWNER_PROTOCOL.major,
    minor: SSH_OWNER_PROTOCOL.minor,
    ownerEpoch: owner.ownerEpoch,
    ...(input.advertisedCapabilities === undefined
      ? {}
      : { advertisedCapabilities: input.advertisedCapabilities }),
    ...(input.requiredCapabilities === undefined
      ? {}
      : { requiredCapabilities: input.requiredCapabilities }),
  });
}

/**
 * Attaches to the live, verified owner for this profile, or spawns exactly one.
 */
export const startOrAttachSshOwnerProduction = Effect.fn("startOrAttachSshOwnerProduction")(
  function* (input: StartSshOwnerProductionInput) {
    const { facts } = input;
    const descriptor = yield* Effect.tryPromise({
      try: () => readSshOwnerAttachmentDescriptor(facts.attachFile),
      catch: (cause) => fromPickerProofError(cause),
    });
    if (descriptor?.socketPath === facts.socketPath) {
      if (descriptor.profileBinding !== facts.profileBindingText) {
        return yield* clientError(
          "profile-mismatch",
          "The SSH owner attach descriptor belongs to a different profile; refusing to adopt it.",
        );
      }
      const attached = yield* Effect.tryPromise({
        try: async () =>
          tryAttach(input, descriptor, await measureSshOwnerArtifactIdentity(input.artifact.path)),
        catch: (cause) => fromPickerProofError(cause),
      });
      // A refused owner from another artifact must be gone before this backend spawns
      // its own; one that does not exit is a typed refusal, never a second owner.
      if (
        attached === "artifact-mismatch" &&
        !(yield* Effect.promise(() =>
          waitForSshOwnerSocketGone(facts.socketPath, input.ownerExitWaitMs),
        ))
      ) {
        return yield* clientError(
          "artifact-mismatch",
          "A live SSH owner from another bigbud installation refused this backend and did not exit. Quit the other bigbud and retry.",
        );
      }
      if (attached && attached !== "artifact-mismatch") {
        negotiate(attached, input);
        requireMultiTarget(attached);
        return makeHandle({
          artifact: input.artifact,
          facts,
          owner: attached,
          mode: "attached",
          releaseGate: async () => undefined,
          detachOwner: () => attached.close(),
          reap: () => attached.close(),
        });
      }
      yield* Effect.promise(() =>
        clearSshOwnerAttachmentDescriptor(facts.attachFile, facts.socketPath).catch(
          () => undefined,
        ),
      );
    }

    const releaseGate = yield* Effect.tryPromise({
      try: () => acquireSshOwnerLaunchGate(facts.directory, facts.lockFile),
      catch: (cause) => fromPickerProofError(cause),
    });
    const capability = newSshOwnerAttachCapability();
    const spawned = yield* Effect.tryPromise({
      try: () =>
        spawnSshOwnerProduction({
          artifact: input.artifact,
          facts,
          capability,
          profileBinding: facts.profileBinding,
          ...(facts.target === undefined ? {} : { targetId: facts.target.targetId }),
          sql: input.sql,
          ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        }),
      catch: (cause) => classifyStartupError(cause),
    }).pipe(
      Effect.tapError(() => Effect.promise(() => releaseGate())),
      Effect.mapError((cause) => fromPickerProofError(cause)),
    );
    // Every failure after the spawn reaps the exact child (bounded) before the
    // typed error surfaces, so a failed start never leaves an owner running.
    return yield* Effect.tryPromise({
      try: async () => {
        try {
          negotiate(spawned, input);
          requireMultiTarget(spawned);
          await writeSshOwnerAttachmentDescriptor(facts.attachFile, {
            version: 1,
            socketPath: facts.socketPath,
            capability,
            profileBinding: facts.profileBindingText,
          });
          return makeHandle({
            artifact: input.artifact,
            facts,
            owner: spawned,
            mode: "spawned",
            releaseGate,
            detachOwner: () => spawned.detach(),
            reap: () => spawned.retireSpawned(),
          });
        } catch (cause) {
          await reapBounded(() => spawned.retireSpawned());
          await releaseGate();
          throw fromPickerProofError(cause);
        }
      },
      catch: (cause) => fromPickerProofError(cause),
    });
  },
);

/** Upper bound on a post-spawn reap: SIGKILL plus the child's close. */
export const SSH_OWNER_STARTUP_REAP_MS = 3_000;

async function reapBounded(reap: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    reap().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SSH_OWNER_STARTUP_REAP_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Builds the boot-sequence owner for a resolved artifact and profile. */
export const startProductionOwnerForBoot = (input: {
  readonly artifact: SshOwnerArtifact;
  readonly profile: Parameters<typeof resolveSshOwnerLaunchFacts>[0];
  readonly binding?: Parameters<typeof resolveSshOwnerLaunchFacts>[1];
  readonly sql: SqlClient.SqlClient;
}): Effect.Effect<SshOwnerProductionHandle, SshOwnerClientError> =>
  Effect.gen(function* () {
    const facts = yield* Effect.try({
      try: () =>
        input.binding === undefined
          ? resolveSshOwnerLaunchFacts(input.profile)
          : resolveSshOwnerLaunchFacts(input.profile, input.binding),
      catch: (cause) => fromPickerProofError(cause),
    });
    return yield* startOrAttachSshOwnerProduction({
      artifact: input.artifact,
      facts,
      sql: input.sql,
    });
  });
