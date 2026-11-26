import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import {
  SSH_OWNER_STARTUP_REAP_MS,
  startOrAttachSshOwnerProduction,
} from "./sshOwnerProductionClient.ts";
import { pidAlive } from "./sshOwnerProductionClient.fakeOwner.ts";
import { killIfAlive, makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it("reaps the spawned owner, bounded, when startup fails after the spawn", async () => {
  const fixture = await makeProductionFixture();
  cleanup.push(fixture.dispose);
  // Inject a post-spawn failure: the owner handshakes, then reports that it
  // pinned one target, which the production client refuses after the spawn.
  const path = await fixture.fakeOwner("single-target");
  const facts = resolveSshOwnerLaunchFacts(fixture.profile);
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  const started = Date.now();
  const failure = await Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
      startOrAttachSshOwnerProduction({
        artifact: fixture.artifact(path),
        facts,
        sql,
      }).pipe(Effect.flip),
    ).pipe(Effect.provide(layer)),
  );
  expect(failure).toMatchObject({ failure: "version-incompatible" });
  const { pid } = await fixture.observation();
  cleanup.push(async () => killIfAlive(pid));
  expect(pid).toBeGreaterThan(0);
  // The reap already completed when startup returned: no wait, no poll.
  expect(pidAlive(pid)).toBe(false);
  expect(Date.now() - started).toBeLessThan(SSH_OWNER_STARTUP_REAP_MS + 5_000);
});
