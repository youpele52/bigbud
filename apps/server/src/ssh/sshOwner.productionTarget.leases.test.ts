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

const terminal = {
  cwd: "/home/fixture",
  threadId: "thread-fixture",
  terminalId: "terminal-fixture",
  cols: 80,
  rows: 24,
};

const expectCode = async (run: () => Promise<unknown>, code: string) => {
  await expect(run()).rejects.toMatchObject({ code });
};

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe("production owner per-target lease identity", () => {
  it("keeps terminal admission refusal scoped to one target", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const first = handle.target(fixture.profile.target!);
        const second = handle.target(otherTarget(fixture));
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => second.inspectTrust());
        expect(first.generation).toHaveLength(32);
        expect(second.generation).toHaveLength(32);
        expect(Buffer.from(first.generation).equals(Buffer.from(second.generation))).toBe(false);

        // This owner is production-only and refuses the fixture terminal lane.
        // The refusal names the exact target and leaves the other target usable.
        yield* Effect.promise(() =>
          expectCode(() => first.prepareProofTerminal(terminal), "operationDenied"),
        );
        yield* Effect.promise(() =>
          expectCode(() => first.closeProofTerminal(bytes(1)), "operationDenied"),
        );
        yield* Effect.promise(() => second.inspectTrust());
        yield* Effect.promise(() => first.inspectTrust());

        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a terminal request for a stale target generation", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const fresh = handle.target(fixture.profile.target!);
        yield* Effect.promise(() => fresh.inspectTrust());
        const stale = handle.target({
          ...fixture.profile.target!,
          targetId: "ssh:stale=1&auth=ssh-key&transport=direct-ssh",
          generation: bytes(0x99),
        });
        // A stale generation is refused before the terminal lane is reached,
        // and the fresh target keeps its lease identity.
        yield* Effect.promise(() =>
          expectCode(() => stale.prepareProofTerminal(terminal), "staleGeneration"),
        );
        expect(fresh.generation).toHaveLength(32);
        yield* Effect.promise(() => fresh.inspectTrust());
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });
});
