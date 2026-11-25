import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import { ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import path from "node:path";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeSshOwnerDevTerminal } from "./sshOwnerDevTerminal.ts";
import { isDevSshOwnerSelected } from "./sshOwnerDevMode.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { SshOwnerDevPickerError } from "./sshOwnerDevPicker.errors.ts";
import { installDevSshOwnerSandbox } from "./sshOwnerDevPicker.sandbox.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";
import {
  bindDevOwnerAlias,
  readDevOwnerProfileConfig,
} from "./sshOwnerDevRuntime.profileConfig.ts";
import { readDevProviderServices } from "./sshOwnerDevRuntime.providerServices.ts";
import { bindLinuxDevJump, linuxDevJumpMode } from "./sshOwnerDevRuntime.jump.ts";
import { bindWindowsDevPicker } from "./sshOwnerDevRuntime.windows.ts";
import {
  approveSshAliasDescriptor,
  checkSshAliasDescriptor,
} from "../persistence/Layers/SshAliasDescriptorBindings.ts";
import {
  markSshOwnerRetirementRetired,
  recordSshOwnerRetirementBinding,
  recordSshOwnerRetirementIntent,
} from "../persistence/Layers/SshOwnerRetirement.ts";

import { initializeDevSshGuardedWriteJournal } from "../persistence/Layers/DevSshGuardedWriteJournal.ts";
import {
  guardedDevProfileSelected,
  makeGuardedDevWorkspace,
} from "./sshOwnerDevRuntime.guarded.ts";

async function makeDevOwnerFixture(guarded: boolean, snapshotCancellation: boolean) {
  if (process.platform === "linux") {
    const fixture = await makeLinuxLoopbackPickerFixture();
    return {
      fixture,
      install: (source: string) =>
        fixture.installOwner(source, { guardedApplyProof: guarded, snapshotCancellation }),
      keyscan: fixture.keyscan,
      interactive: false,
    };
  }
  const fixture = await makeLoopbackPickerFixture({ allowInteractiveShell: !guarded });
  return {
    fixture,
    install: (source: string) =>
      installDevSshOwnerSandbox({
        root: fixture.root,
        source,
        existingClientPolicy: fixture.clientSandboxPolicy,
        allowPty: !guarded,
        guardedApplyProof: guarded,
      }),
    keyscan: "/usr/bin/ssh-keyscan",
    interactive: true,
  };
}

import {
  attachRetainedDevOwner,
  retainedAlias,
  retainedProfileSelected,
  retainedTargetId,
} from "./sshOwnerDevRuntime.retained.ts";

const fallbackAlias = retainedAlias;

/** One fixture, one owner and one storage writer per authenticated WebSocket route. */
export const makeDevSshOwnerRuntime = Effect.fn("makeDevSshOwnerRuntime")(function* () {
  if (!isDevSshOwnerSelected()) return undefined;
  const binary = process.env.BIGBUD_SSH_OWNER_BIN;
  if (
    !["darwin", "linux", "win32"].includes(process.platform) ||
    !binary ||
    !path.isAbsolute(binary)
  ) {
    return yield* Effect.die(new Error("The Rust SSH owner requires an isolated dev runner."));
  }
  const client = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (client._tag === "None") {
    return yield* Effect.die(
      new Error("The Rust SSH owner needs the dev profile's migrated database."),
    );
  }
  const sql = client.value;
  const scope = yield* Effect.scope;
  const profile = process.env.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
  if (profile && (yield* Effect.promise(() => retainedProfileSelected(profile)))) {
    const bound = yield* Effect.acquireRelease(
      Effect.promise(() => attachRetainedDevOwner(profile, sql)),
      ({ owner }) => Effect.promise(() => owner.close()),
    );
    const { fixture, owner } = bound;
    const targetId = retainedTargetId;
    const picker = makeSshOwnerDevPicker({
      executionTargetId: targetId,
      host: fixture.host,
      startOwner: async () => owner,
    });
    yield* Scope.addFinalizer(scope, Effect.promise(picker.close));
    const terminal = yield* makeDevTerminal(targetId, fixture, picker.withOwner, sql, true);
    yield* Effect.logInfo("Supervised disposable Rust SSH owner attached (no fallback)");
    return {
      kind: "retained-unix" as const,
      alias: retainedAlias,
      targetId,
      fixture,
      picker,
      sql,
      terminal,
    };
  }
  const jumpMode = profile ? yield* Effect.promise(() => linuxDevJumpMode(profile)) : undefined;
  if (profile && jumpMode) {
    const session = yield* Effect.acquireRelease(
      Effect.promise(() => bindLinuxDevJump(profile, binary, sql, jumpMode === "first-use")),
      (bound) => Effect.promise(bound.close),
    ).pipe(Scope.provide(scope));
    return session;
  }
  const profileConfig = yield* Effect.promise(() => readDevOwnerProfileConfig(profile));
  const alias = profileConfig?.alias ?? fallbackAlias;
  const targetId = `ssh:${new URLSearchParams({ host: alias, auth: "ssh-key", transport: "direct-ssh" })}`;
  if (process.platform === "win32") {
    if (!profile) return yield* Effect.die(new Error("Missing Windows SSH owner dev profile."));
    const session = yield* Effect.promise(() =>
      bindWindowsDevPicker(profile, binary, alias, targetId, sql),
    );
    yield* Scope.addFinalizer(scope, Effect.promise(session.picker.close));
    yield* Effect.promise(() => session.picker.withOwner(targetId, async () => undefined));
    yield* Effect.logInfo(
      "Rust SSH owner dev picker selected (Windows named pipe; no legacy fallback)",
    );
    return session;
  }
  const guardedProfile =
    profile && !profileConfig && (yield* Effect.promise(() => guardedDevProfileSelected(profile)))
      ? profile
      : undefined;
  const journal = guardedProfile
    ? yield* initializeDevSshGuardedWriteJournal(sql).pipe(Effect.option)
    : undefined;
  const guarded = journal?._tag === "Some";
  const snapshotCancellation =
    !guardedProfile &&
    (process.platform === "darwin" ||
      (process.platform === "linux" && process.arch === "arm64" && !profileConfig));
  const providerServices = yield* Effect.promise(() => readDevProviderServices(profile));
  const { fixture, install, keyscan, interactive } = yield* Effect.acquireRelease(
    Effect.promise(() => makeDevOwnerFixture(guarded, snapshotCancellation)),
    ({ fixture }) => Effect.promise(fixture.dispose),
  ).pipe(Scope.provide(scope));
  // The explicit proof fixture has a literal generated endpoint, not a configured SSH alias.
  // Never substitute it for a profile alias; that path keeps native descriptor policy.
  const { aliasConfig } = guarded
    ? {}
    : yield* Effect.promise(() => bindDevOwnerAlias(fixture, alias, profileConfig));
  const launcher = yield* Effect.promise(async () => {
    const source = await realpath(binary);
    await access(source, constants.X_OK);
    const wrapper = await install(source);
    await fixture.start();
    return wrapper;
  });
  const picker = makeSshOwnerDevPicker({
    executionTargetId: targetId,
    host: fixture.host,
    ...(profileConfig
      ? {
          // The binding is scoped to this profile's validated root, not to the shared database.
          aliasBinding: {
            check: (descriptor: Uint8Array) =>
              Effect.runPromise(
                checkSshAliasDescriptor(
                  sql,
                  path.dirname(profileConfig.sourcePath),
                  targetId,
                  descriptor,
                ),
              ),
            approve: (descriptor: Uint8Array, mode: "firstUse" | "reapprove") =>
              Effect.runPromise(
                approveSshAliasDescriptor(
                  sql,
                  path.dirname(profileConfig.sourcePath),
                  targetId,
                  descriptor,
                  mode,
                ),
              ),
          },
          checkAliasSource: async () => {
            const current = await readDevOwnerProfileConfig(profile).catch(() => undefined);
            if (current?.content !== profileConfig.content) {
              throw new SshOwnerDevPickerError(
                "configUnsupported",
                "The disposable SSH config changed. Restart this development profile to load the updated alias.",
              );
            }
          },
        }
      : {}),
    startOwner: async (profileBinding) => {
      // The owner journal is authoritative; this row is the Build A mirror.
      const intent = await Effect.runPromise(
        recordSshOwnerRetirementIntent(sql, {
          profileScope: fixture.root,
          targetId,
          detail: "development owner start",
        }),
      );
      if (intent === "unresolved") {
        throw new SshOwnerDevPickerError(
          "ownerRetirementUnverified",
          "The previous SSH owner's retirement record could not be verified. Stop bigbud and inspect the owner retirement record before retrying.",
        );
      }
      const owner = await startPickerProofOwner({
        binary: launcher,
        profileBinding,
        targetId,
        lockFile: path.join(fixture.root, "owner.lock"),
        sshBinary: fixture.ssh,
        keyscanBinary: keyscan,
        host: fixture.loopback,
        port: fixture.port,
        user: fixture.user,
        identityFile: fixture.identity,
        knownHostsFile: fixture.knownHosts,
        ...(aliasConfig ? { aliasConfig } : {}),
        workspaceRoot: fixture.folder,
        ...providerServices,
        ...(interactive ? { devInteractiveTerminal: true } : {}),
        ...(snapshotCancellation ? { posixWorkspaceSnapshotCancellation: true } : {}),
        sql,
      });
      const bound = await Effect.runPromise(
        recordSshOwnerRetirementBinding(sql, {
          profileScope: fixture.root,
          targetId,
          detail: "development owner bound",
          ownerEpoch: Buffer.from(owner.ownerEpoch).toString("hex"),
          generation: Buffer.from(owner.targetGeneration).toString("hex"),
        }),
      );
      if (bound !== "recorded") {
        await owner.close().catch(() => undefined);
        throw new SshOwnerDevPickerError(
          "ownerRetirementUnverified",
          "The SSH owner started but its retirement mirror could not be bound. Stop bigbud and inspect the retirement record before retrying.",
        );
      }
      return owner;
    },
  });
  yield* Scope.addFinalizer(
    scope,
    Effect.promise(async () => {
      await picker.close();
      await Effect.runPromise(
        markSshOwnerRetirementRetired(sql, fixture.root, targetId, "development owner closed"),
      );
    }),
  );
  yield* Effect.logInfo("Rust SSH owner dev picker selected");
  if (guardedProfile && journal?._tag === "Some") {
    const guardedWorkspace = makeGuardedDevWorkspace({
      profileId: guardedProfile,
      targetId,
      cwd: fixture.folder,
      withOwner: picker.withOwner,
      journal: journal.value,
    });
    return {
      kind: "unix" as const,
      alias,
      targetId,
      fixture,
      picker,
      sql,
      terminal: undefined,
      guardedWorkspace,
    };
  }
  if (!interactive)
    return {
      kind: "unix" as const,
      alias,
      targetId,
      fixture,
      picker,
      sql,
      terminal: undefined,
    };
  const terminal = yield* makeDevTerminal(targetId, fixture, picker.withOwner, sql);
  return {
    kind: "unix" as const,
    alias,
    targetId,
    fixture,
    picker,
    sql,
    terminal,
  };
});

const makeDevTerminal = Effect.fn("makeDevTerminal")(function* (
  targetId: string,
  fixture: { readonly root: string; readonly folder: string },
  withOwner: Parameters<typeof makeSshOwnerDevTerminal>[0]["withOwner"],
  sql: SqlClient.SqlClient,
  recoverRetained = false,
) {
  const owners = yield* makeRemoteAgentRuntimeBindings.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.orDie,
  );
  const binaryPath = path.join(fixture.root, "picker-owner");
  const sha256 = yield* Effect.promise(async () =>
    createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex"),
  );
  return makeSshOwnerDevTerminal({
    targetId,
    workspaceRoot: fixture.folder,
    recoverRetained,
    withOwner,
    owners: () => owners,
    runtime: {
      generation: "dev-ssh-owner",
      version: "0.1.0",
      sha256,
      buildDigest: sha256,
      // The local terminal route reuses the legacy storage triple discriminator only.
      targetTriple:
        process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
      origin: "legacy-external",
      binaryPath,
      statePath: fixture.root,
      socketPath: path.join(fixture.root, "supervisor.sock"),
      logPath: path.join(fixture.root, "supervisor.log"),
    },
  });
});

export class DevSshOwnerRuntime extends ServiceMap.Service<
  DevSshOwnerRuntime,
  { readonly session: Effect.Success<ReturnType<typeof makeDevSshOwnerRuntime>> }
>()("bigbud/dev/sshOwner") {}

export const DevSshOwnerRuntimeLive = Layer.effect(
  DevSshOwnerRuntime,
  Effect.map(makeDevSshOwnerRuntime(), (session) => ({ session })),
);
