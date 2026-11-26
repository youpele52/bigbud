import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendInstance } from "../startup/backendInstance.ts";
import { ServerConfig } from "../startup/config.ts";
import {
  configureSshOwner,
  readSshOwnerAdmission,
  resetSshOwnerProductionStateForTest,
  SshOwnerProductionBootLive,
} from "./sshOwnerProductionComposition.ts";
import { readSshOwnerProductionOwner } from "./sshOwnerProductionRegistry.ts";
import type { SshOwnerTargetDescriptor } from "./sshOwnerProductionClient.launch.ts";

const fake = vi.hoisted(() => ({
  deaths: new Set<() => void>(),
  shutdowns: 0,
  state: "open" as "open" | "dead" | "detached",
}));

vi.mock("./sshOwnerProductionClient.ts", async (importOriginal) => {
  const { Effect: E } = await import("effect");
  return {
    ...(await importOriginal<typeof import("./sshOwnerProductionClient.ts")>()),
    startProductionOwnerForBoot: () =>
      E.succeed({
        profile: "remote-backend",
        artifactPath: "/fake/owner",
        mode: "spawned",
        ownerEpoch: new Uint8Array(32),
        targetGeneration: new Uint8Array(32),
        state: () => fake.state,
        target: () => {
          throw new Error("not used");
        },
        hydrate: () => E.void,
        onDeath: (listener: () => void) => {
          fake.deaths.add(listener);
          return () => fake.deaths.delete(listener);
        },
        shutdown: () =>
          E.sync(() => {
            fake.shutdowns += 1;
          }),
      }),
  };
});

// The registry must delegate to the production per-target resolver.
vi.mock("./sshOwnerProductionTargets.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sshOwnerProductionTargets.ts")>();
  return {
    ...actual,
    resolveProductionTargetDescriptor: async (targetId: string) => {
      if (targetId === "ssh:primary") return resolvedPrimary;
      throw new actual.SshOwnerTargetRefusal("config-refused");
    },
  };
});

vi.mock("./sshOwnerStartupRefusal.ts", async (importOriginal) => {
  const { Effect: E } = await import("effect");
  return {
    ...(await importOriginal<typeof import("./sshOwnerStartupRefusal.ts")>()),
    readSshOwnerStartupState: () => E.succeed({ kind: "admitted", marker: {}, record: {} }),
  };
});

vi.mock("./sshOwnerProductionHydration.ts", async (importOriginal) => {
  const { Effect: E } = await import("effect");
  return {
    ...(await importOriginal<typeof import("./sshOwnerProductionHydration.ts")>()),
    readSshOwnerHydrationSnapshot: () => E.succeed({}),
  };
});

const resolvedPrimary = vi.hoisted(() => ({
  targetId: "ssh:primary",
  kind: "structured" as const,
  host: "build.example.internal",
  port: 22,
  user: "tester",
  identityFile: "/srv/id",
  knownHostsFile: "/srv/known_hosts",
}));

const primary: SshOwnerTargetDescriptor = {
  targetId: "ssh:primary",
  kind: "structured",
  host: "127.0.0.1",
  port: 22,
  user: "tester",
  identityFile: "/srv/id",
  knownHostsFile: "/srv/known_hosts",
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "ssh-owner-registry-"));
  resetSshOwnerProductionStateForTest();
  fake.deaths.clear();
  fake.shutdowns = 0;
  fake.state = "open";
});
afterEach(async () => {
  resetSshOwnerProductionStateForTest();
  await rm(root, { recursive: true, force: true });
});

async function boot() {
  const config = { mode: "remote", devUrl: undefined, stateDir: root } as const;
  await Effect.runPromise(
    configureSshOwner(config, "file:///unused", {
      artifactOverride: {
        profile: "remote-backend",
        path: "/fake/owner",
        target: {} as never,
        evidence: "header",
      },
      ownerProfile: { stateDirectory: root, target: primary },
    }),
  );
  const scope = await Effect.runPromise(Scope.make());
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, config as never),
    Layer.succeed(SqlClient.SqlClient, {} as never),
    Layer.succeed(BackendInstance, { assertHeld: async () => {} } as never),
  );
  await Effect.runPromise(
    Layer.buildWithScope(SshOwnerProductionBootLive.pipe(Layer.provide(services)), scope),
  );
  return scope;
}

describe("production SSH owner registry publication", () => {
  it("registers the open owner with the per-target resolver and unregisters on finalizer", async () => {
    const scope = await boot();
    expect(readSshOwnerAdmission().kind).toBe("open");
    const live = readSshOwnerProductionOwner();
    expect(live).toBeDefined();
    // Resolution is per target through the production resolver, not the
    // launch profile's primary descriptor; a host name stays a name.
    await expect(live?.descriptorFor("ssh:primary")).resolves.toEqual(resolvedPrimary);
    await expect(live?.descriptorFor("ssh:other")).rejects.toMatchObject({
      reason: "config-refused",
    });
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(readSshOwnerProductionOwner()).toBeUndefined();
    expect(fake.shutdowns).toBe(1);
  });

  it("unregisters and closes admission on owner death", async () => {
    const scope = await boot();
    expect(readSshOwnerProductionOwner()).toBeDefined();
    fake.state = "dead";
    for (const listener of fake.deaths) listener();
    fake.state = "open";
    // Even with the handle reporting open again, the registration is gone.
    expect(readSshOwnerProductionOwner()).toBeUndefined();
    expect(readSshOwnerAdmission()).toMatchObject({ kind: "closed", step: "owner-attach" });
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
