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

const expectCode = async (run: () => Promise<unknown>, code: string) => {
  await expect(run()).rejects.toMatchObject({ code });
};

describe("production owner per-target agent proxy", () => {
  it("holds independent proxies and closes only the selected target", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const first = handle.target(fixture.profile.target!);
        const second = handle.target(otherTarget(fixture, "ssh:agent=other"));
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => second.inspectTrust());

        // Both targets hold a proxy at the same time; the leases are distinct.
        const firstLease = yield* Effect.promise(() => first.openAgentProxy());
        const secondLease = yield* Effect.promise(() => second.openAgentProxy());
        expect(firstLease.closed).toBe(false);
        expect(secondLease.closed).toBe(false);
        expect(Buffer.from(firstLease.lease).equals(Buffer.from(secondLease.lease))).toBe(false);

        const closed = yield* Effect.promise(() =>
          first.closeAgentProxy(firstLease.lease, firstLease.pid, {
            terminate: true,
            timeoutMs: 2_000,
          }),
        );
        expect(closed.closed).toBe(true);
        // The second target's lease is untouched by the first teardown.
        const stillOpen = yield* Effect.promise(() =>
          second.agentProxyStatus(secondLease.lease, secondLease.pid),
        );
        expect(stillOpen.closed).toBe(false);
        yield* Effect.promise(() =>
          second.closeAgentProxy(secondLease.lease, secondLease.pid, {
            terminate: false,
            timeoutMs: 2_000,
          }),
        );

        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a stale target generation before opening a proxy", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const stale = handle.target({
          ...fixture.profile.target!,
          targetId: "ssh:agent=stale",
          generation: Buffer.alloc(32, 0x99),
        });
        yield* Effect.promise(() => expectCode(() => stale.openAgentProxy(), "staleGeneration"));
        // A fresh descriptor for the same id still opens independently.
        const fresh = handle.target(otherTarget(fixture, "ssh:agent=fresh"));
        yield* Effect.promise(() => fresh.inspectTrust());
        const lease = yield* Effect.promise(() => fresh.openAgentProxy());
        expect(lease.closed).toBe(false);
        yield* Effect.promise(() =>
          fresh.closeAgentProxy(lease.lease, lease.pid, { terminate: true, timeoutMs: 2_000 }),
        );
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });
});
