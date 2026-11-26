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

const otherTarget = (fixture: ProductionFixture, targetId: string) => ({
  ...fixture.profile.target!,
  targetId,
});

const scope = {
  threadId: "thread-opencode",
  sessionEpoch: 1,
  cwd: "/home/fixture",
};

const expectCode = async (run: () => Promise<unknown>, code: string) => {
  await expect(run()).rejects.toMatchObject({ code });
};

describe("production owner per-target OpenCode", () => {
  it("binds an independent listener per target and tears down only one", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const first = handle.target(fixture.profile.target!);
        const second = handle.target(otherTarget(fixture, "ssh:opencode=other"));
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => second.inspectTrust());

        const firstState = yield* Effect.promise(() => first.openOpencode(scope));
        const secondState = yield* Effect.promise(() => second.openOpencode(scope));
        expect(firstState.phase).toBe("ready");
        expect(secondState.phase).toBe("ready");
        expect(firstState.phase === "ready" ? firstState.localPort : 0).not.toBe(
          secondState.phase === "ready" ? secondState.localPort : 0,
        );

        const closed = yield* Effect.promise(() => first.closeOpencode(firstState.lease));
        expect(closed.phase).toBe("closed");
        // The second target keeps its listener ready after the first teardown.
        const stillReady = yield* Effect.promise(() => second.opencodeStatus(secondState.lease));
        expect(stillReady.phase).toBe("ready");
        expect(stillReady.phase === "ready" ? stillReady.localPort : 0).toBe(
          secondState.phase === "ready" ? secondState.localPort : 0,
        );
        yield* Effect.promise(() => second.closeOpencode(secondState.lease));

        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a stale target generation before opening a listener", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const stale = handle.target({
          ...fixture.profile.target!,
          targetId: "ssh:opencode=stale",
          generation: Buffer.alloc(32, 0x99),
        });
        yield* Effect.promise(() => expectCode(() => stale.openOpencode(scope), "staleGeneration"));
        const fresh = handle.target(otherTarget(fixture, "ssh:opencode=fresh"));
        yield* Effect.promise(() => fresh.inspectTrust());
        const state = yield* Effect.promise(() => fresh.openOpencode(scope));
        expect(state.phase).toBe("ready");
        yield* Effect.promise(() => fresh.closeOpencode(state.lease));
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });
});
