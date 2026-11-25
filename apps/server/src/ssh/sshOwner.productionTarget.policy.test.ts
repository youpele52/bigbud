import { readFile } from "node:fs/promises";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
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

const unsupportedTarget = (fixture: ProductionFixture) => ({
  ...fixture.profile.target!,
  targetId: "ssh:unsupported=1&auth=ssh-key&transport=direct-ssh",
});

describe("production owner per-target policy", () => {
  it("refuses unsupported policy for one target before any request and keeps the other usable", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const rejected = unsupportedTarget(fixture).targetId;
    const path = await fixture.fakeOwner("policy-refusal", { rejectTarget: rejected });
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* startOrAttachSshOwnerProduction({
          artifact: fixture.artifact(path),
          facts: resolveSshOwnerLaunchFacts(fixture.profile),
          sql,
        });
        const usable = handle.target(fixture.profile.target!);
        const unsupported = handle.target(unsupportedTarget(fixture));
        yield* Effect.promise(() => usable.inspectTrust());
        yield* Effect.promise(() =>
          expect(unsupported.inspectTrust()).rejects.toMatchObject({ code: "configUnsupported" }),
        );
        // The refused target never reached a request frame (no dial, no admission).
        const activity = yield* Effect.promise(() => readFile(fixture.activityFile, "utf8"));
        expect(activity).toContain(`grant ${rejected}`);
        expect(activity).not.toContain(`request ${rejected}`);
        expect(activity).toContain(`request ${fixture.profile.target!.targetId}`);
        // The other target keeps working on the same owner.
        yield* Effect.promise(() => usable.inspectTrust());
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });
});
