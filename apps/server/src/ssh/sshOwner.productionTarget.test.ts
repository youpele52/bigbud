import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import type { SshOwnerProductionProfile } from "./sshOwnerProductionClient.launch.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import {
  killIfAlive,
  makeProductionFixture,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";

type Sql = SqlClient.SqlClient;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function withPersistence<A, E>(
  fixture: ProductionFixture,
  run: (sql: Sql) => Effect.Effect<A, E>,
): Promise<A> {
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  return Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
      Effect.provideService(run(sql), SqlClient.SqlClient, sql),
    ).pipe(Effect.provide(layer)),
  );
}

const profileOf = (fixture: ProductionFixture): SshOwnerProductionProfile => fixture.profile;

const start = (fixture: ProductionFixture, sql: Sql, path: string) =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact(path),
    facts: resolveSshOwnerLaunchFacts(profileOf(fixture)),
    sql,
  });

const otherTarget = (fixture: ProductionFixture) => {
  const primary = fixture.profile.target!;
  return { ...primary, targetId: "ssh:host=other&auth=ssh-key&transport=direct-ssh" };
};

const expectCode = async (run: () => Promise<unknown>, code: string) => {
  await expect(run()).rejects.toMatchObject({ code });
};

describe("production owner per-target requests", () => {
  it("spawns without a target and serves two targets from one owner", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const observation = yield* Effect.promise(() => fixture.observation());
        // No target at spawn: only profile, state dir, images and the attach socket.
        const primary = fixture.profile.target!;
        for (const leaked of [
          primary.targetId,
          primary.host,
          String(primary.port),
          primary.user,
          primary.identityFile,
          primary.knownHostsFile,
        ]) {
          expect(observation.argv).not.toContain(leaked);
        }
        expect(observation.argv.slice(7, 11)).toEqual([
          "--ssh",
          "/usr/bin/ssh",
          "--keyscan",
          "/usr/bin/ssh-keyscan",
        ]);

        const first = handle.target(primary);
        const second = handle.target(otherTarget(fixture));
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => second.inspectTrust());
        expect(first.generation).toHaveLength(32);
        expect(second.generation).toHaveLength(32);
        expect(Buffer.from(first.generation).equals(Buffer.from(second.generation))).toBe(false);
        // Each target kept its own durable snapshot and descriptor.
        expect(first.hydratedStorage?.writerEpoch).toBeTruthy();
        expect(second.hydratedStorage?.writerEpoch).toBeTruthy();
        // Both remain usable independently after the other was used.
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => second.inspectTrust());
        const activity = yield* Effect.promise(() => readFile(fixture.activityFile, "utf8"));
        expect(activity).toContain(`request ${primary.targetId}`);
        expect(activity).toContain(`request ${otherTarget(fixture).targetId}`);
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a request whose grant belongs to another target", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const rejected = otherTarget(fixture).targetId;
    const path = await fixture.fakeOwner("wrong-target", { rejectTarget: rejected });
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const first = handle.target(fixture.profile.target!);
        const second = handle.target(otherTarget(fixture));
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => expectCode(() => second.inspectTrust(), "targetMismatch"));
        // The refused target is never dispatched, and the first target still works.
        yield* Effect.promise(() => first.inspectTrust());
        const activity = yield* Effect.promise(() => readFile(fixture.activityFile, "utf8"));
        expect(activity).toContain(`grant ${rejected}`);
        expect(activity).not.toContain(`request ${rejected}`);
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses an owner that pinned one target at startup", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("single-target");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(start(fixture, sql, path));
        expect(failure).toMatchObject({ failure: "version-incompatible" });
        const observation = yield* Effect.promise(() => fixture.observation());
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a stale target generation", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const stale = handle.target({
          ...fixture.profile.target!,
          targetId: "ssh:stale=1&auth=ssh-key&transport=direct-ssh",
          generation: Buffer.alloc(32, 0x99),
        });
        yield* Effect.promise(() => expectCode(() => stale.inspectTrust(), "staleGeneration"));
        // A fresh descriptor without a generation still works.
        const fresh = handle.target(fixture.profile.target!);
        yield* Effect.promise(() => fresh.inspectTrust());
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });
});
