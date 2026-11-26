import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, expect, it } from "vitest";

import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { registerSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { detectInstalledProxyBinding } from "./remoteAgentComposition.installedAdmission.ts";
import { composeProductionInstalledStartups } from "./remoteAgentComposition.installedStartup.production.ts";
import { makeRemoteAgentOwnerExec } from "./remoteAgentControl.owner.ts";
import { remoteAgentOwnerSelection } from "./remoteAgentControl.selection.ts";
import { getConfiguredRemoteAgentComposition } from "./remoteAgentDefault.ts";
import { clearInstalledRemoteAgentStartups } from "./remoteAgentInstalledStartup.state.ts";
import { makeRemoteAgentInstallManager } from "./remoteAgentInstallManager.ts";
import { configureRemoteAgentOwners } from "./remoteAgentOwners.ts";
import { readRemoteAgentRegistryReadOnly } from "./remoteAgentReadOnlyStatus.ts";
import { makeRemoteAgentUpdateCoordinator } from "./remoteAgentUpdate.coordinator.ts";
import {
  external,
  harnessShell,
  LABEL,
  liveReady,
  signedBuild,
  withOwner,
  type OwnerLive,
} from "./remoteAgentControl.owner.live.fixture.ts";

/**
 * U25 decision (a), live: a fresh admission through the product path (update coordinator,
 * install manager, admission) on the production owner writes the local owner store binding.
 * After a full server-side restart (new owner process, store reopened from the same SQLite file,
 * in-memory startup state cleared), normal startup observes the bound runtime and epoch through an
 * owner proxy lease, composes the installed proxy, and a pool connection reaches the agent, with
 * no install or upload. Run with BIGBUD_SSH_OWNER_ACTIVATION=1 (local checkout override).
 */
const activated = liveReady && remoteAgentOwnerSelection() !== undefined;
// Created only when the live case runs, so a skipped collection leaves nothing behind.
let scratch: string | undefined;
const database = () => {
  scratch ??= mkdtempSync(path.join(tmpdir(), "bb-u25-startup-"));
  return path.join(scratch, "server.sqlite");
};
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** One "server process": its owner store reopened from the persistent SQLite file. */
async function asServer<A>(run: (owner: OwnerLive, target: string) => Promise<A>): Promise<A> {
  const runtime = ManagedRuntime.make(
    makeSqlitePersistenceLive(database(), { worker: false }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  try {
    configureRemoteAgentOwners(await runtime.runPromise(makeRemoteAgentRuntimeBindings));
    return await withOwner(async (owner) => {
      const registration = owner.live.owner()!;
      const unregister = registerSshOwnerProductionOwner(
        registration as SshOwnerProductionRegistration,
      );
      try {
        // The agent transport for the same host; the owner descriptor is resolved per target.
        const target = owner.targetId.replace("transport=direct-ssh", "transport=agent");
        return await run(owner, target);
      } finally {
        unregister();
      }
    });
  } finally {
    await runtime.dispose();
  }
}

it.skipIf(!activated)(
  `normal startup observes and proxies the locally bound agent after a restart (${LABEL})`,
  async () => {
    harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');
    const build = signedBuild(0);
    let installs = 0;
    const bound = await asServer(async (_owner, target) => {
      const manager = makeRemoteAgentInstallManager({
        readArtifactBytes: async () => build.bytes,
        referencedBuildIds: async () => new Set(),
      });
      const coordinator = makeRemoteAgentUpdateCoordinator({
        installManager: {
          ...manager,
          install: (input) => {
            installs += 1;
            return manager.install(input);
          },
        },
        loadInstallSource: Object.assign(async () => build.source, {
          refresh: async () => build.source,
        }),
        hasReusableCredentials: async () => true,
      });
      const requestId = randomUUID();
      const binding = await remoteAgentAdmission.fresh(target, requestId, () =>
        coordinator.prepareForAdmission(target, requestId),
      );
      const registry = await readRemoteAgentRegistryReadOnly(target);
      expect(detectInstalledProxyBinding(target, registry)).toEqual({
        kind: "denied",
        reason: "observation-required",
      });
      return binding;
    });
    expect(installs).toBe(1);

    // Restart: new owner process, store reopened, no in-memory startup state.
    clearInstalledRemoteAgentStartups();
    await asServer(async (owner, target) => {
      const results = await composeProductionInstalledStartups({
        selection: remoteAgentOwnerSelection()!,
        owners: (await import("./remoteAgentOwners.ts")).remoteAgentOwners(),
      });
      expect(results.get(target)?.kind).toBe("ready");
      const composition = getConfiguredRemoteAgentComposition(target);
      expect(composition).not.toBeNull();
      // The pool connects only to the observed binding (it rechecks hello on create).
      await composition!.pool.get(target);
      expect(composition!.pool.liveConnection(target)).not.toBeNull();
      const ready = results.get(target);
      const stored = await (
        await import("./remoteAgentOwners.ts")
      )
        .remoteAgentOwners()
        .getBinding(target);
      expect(ready?.kind === "ready" && ready.observation.supervisorEpoch).toBe(
        stored?.expectedEpoch,
      );
      expect(stored).toMatchObject({ runtime: { generation: expect.any(String) } });
      void bound;
      composition!.pool.closeAll();
      expect(installs).toBe(1);
      const exec = makeRemoteAgentOwnerExec(owner.live, target);
      const registry = await readRemoteAgentRegistryReadOnly(target);
      const runtime = registry!.builds.find((entry) => entry.id === registry!.current)!.runtime;
      expect((await exec({ kind: "supervisorShutdown", runtime })).stdout.trim()).toBe(
        "shutdown-accepted",
      );
    });
    harnessShell(external!, 'rm -rf -- "$HOME/.bigbud"');
  },
  600_000,
);
