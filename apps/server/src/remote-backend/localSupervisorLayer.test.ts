import {
  localSupervisorTestTarget as targetId,
  localSupervisorTestIdentity as identityValue,
  localSupervisorTestIdentityLayer as identity,
  seedLocalSupervisorBinding as retainedSeed,
} from "./localSupervisorLayer.test.helpers.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { PtyAdapter } from "../terminal/Services/PTY.ts";
import { RemoteLocalSupervisorPtyLive } from "./localSupervisorLayer.ts";
import {
  RemoteTerminalAvailability,
  RemoteTerminalAvailabilityLive,
} from "./terminalAvailability.ts";
import { localSupervisorTarget } from "./localSupervisorIdentity.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { claimLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp("/tmp/bb-local-adopt-");
  vi.stubEnv("HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});
describe("remote composition local supervisor adoption", () => {
  it("does not create account installation state or launch anything when no setup exists", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        const availability = yield* RemoteTerminalAvailability;
        expect(adapter.ownedRuntimeForTarget).toBeUndefined();
        expect(yield* availability.available).toBe(false);
        const failure = yield* adapter
          .spawn({
            ownerKey: "fixture",
            shell: "/bin/sh",
            cwd: "/work",
            cols: 80,
            rows: 24,
            env: {},
          })
          .pipe(Effect.flip);
        expect(failure.adapter).toBe("remote");
      }).pipe(
        Effect.provide(
          RemoteLocalSupervisorPtyLive.pipe(
            Layer.provideMerge(RemoteTerminalAvailabilityLive),
            Layer.provide(identity),
            Layer.provide(SqlitePersistenceMemory),
          ),
        ),
      ),
    );
    await expect(fs.lstat(join(home, ".bigbud"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains scoped ownership and refuses replacement when a previously bound installation disappears", async () => {
    const seed = retainedSeed();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        const availability = yield* RemoteTerminalAvailability;
        expect(adapter.ownedRuntimeForTarget!("local")?.targetId).toBe(targetId);
        expect(yield* availability.available).toBe(false);
        const failure = yield* adapter
          .spawn({
            ownerKey: "fixture",
            shell: "/bin/sh",
            cwd: "/work",
            cols: 80,
            rows: 24,
            env: {},
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("installation is missing");
      }).pipe(
        Effect.provide(
          RemoteLocalSupervisorPtyLive.pipe(
            Layer.provideMerge(seed),
            Layer.provideMerge(RemoteTerminalAvailabilityLive),
            Layer.provide(identity),
            Layer.provide(SqlitePersistenceMemory),
          ),
        ),
      ),
    );
    await expect(fs.lstat(join(home, ".bigbud"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not adopt or claim a nonempty unreserved legacy account root", async () => {
    const root = join(home, ".bigbud/agent");
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(root, "legacy"), "preserve", { mode: 0o600 });
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        const availability = yield* RemoteTerminalAvailability;
        expect(adapter.ownedRuntimeForTarget).toBeUndefined();
        expect(yield* availability.available).toBe(false);
      }).pipe(
        Effect.provide(
          RemoteLocalSupervisorPtyLive.pipe(
            Layer.provideMerge(RemoteTerminalAvailabilityLive),
            Layer.provide(identity),
            Layer.provide(SqlitePersistenceMemory),
          ),
        ),
      ),
    );
    expect(await fs.readdir(root)).toEqual(["legacy"]);
  });

  it("preserves retained bindings and refuses a foreign authority before adoption or dispatch", async () => {
    const canonical = await fs.realpath(home);
    const foreign = {
      ...identityValue,
      authority: { ...identityValue.authority, authorityId: "b".repeat(32) },
    };
    const control = makeLocalSupervisorControl({
      homeDir: canonical,
      targetId: localSupervisorTarget(foreign.authority.authorityId),
    });
    const backendHome = join(canonical, "backend");
    const backendStateDir = join(backendHome, "state");
    await fs.mkdir(backendStateDir, { recursive: true, mode: 0o700 });
    await claimLocalSupervisorAuthorityReservation(control, foreign, {
      confirmFreshSetup: true,
      backendHome,
      backendStateDir,
    });
    const marker = join(control.root, "account-authority-v1");
    const original = await fs.readFile(marker, "utf8");
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PtyAdapter;
        const owners = yield* RemoteAgentRuntimeOwners;
        const before = yield* Effect.promise(() => owners.getBinding(targetId));
        const availability = yield* RemoteTerminalAvailability;
        expect(adapter.ownedRuntimeForTarget!("local")?.targetId).toBe(targetId);
        expect(yield* availability.available).toBe(false);
        const failure = yield* adapter
          .spawn({
            ownerKey: "fixture",
            shell: "/bin/sh",
            cwd: "/work",
            cols: 80,
            rows: 24,
            env: {},
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("ownership");
        expect(yield* Effect.promise(() => owners.getBinding(targetId))).toEqual(before);
      }).pipe(
        Effect.provide(
          RemoteLocalSupervisorPtyLive.pipe(
            Layer.provideMerge(retainedSeed()),
            Layer.provideMerge(RemoteTerminalAvailabilityLive),
            Layer.provide(identity),
            Layer.provide(SqlitePersistenceMemory),
          ),
        ),
      ),
    );
    expect(await fs.readFile(marker, "utf8")).toBe(original);
    expect(await fs.readdir(control.root)).toEqual(["account-authority-v1"]);
  });
});
