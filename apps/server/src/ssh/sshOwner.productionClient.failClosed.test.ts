import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import { pidAlive } from "./sshOwnerProductionClient.fakeOwner.ts";
import { killIfAlive, makeProductionFixture } from "./sshOwnerProductionClient.fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/**
 * A spawned production owner whose session fails closed (here: a truncated reply
 * frame) must still be reaped by shutdown. The fake owner, like a real owner with
 * an attachment endpoint, ignores its launcher's end-of-input and keeps running.
 */
it("reaps a spawned owner whose session failed closed", async () => {
  const fixture = await makeProductionFixture();
  cleanup.push(fixture.dispose);
  const path = await fixture.fakeOwner("malformed-reply");
  const facts = resolveSshOwnerLaunchFacts(fixture.profile);
  const layer = makeSqlitePersistenceLive(join(fixture.stateDirectory, "state.sqlite"), {
    worker: false,
  }).pipe(Layer.provide(NodeServices.layer));
  const failure = await Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
      Effect.gen(function* () {
        const handle = yield* startOrAttachSshOwnerProduction({
          artifact: fixture.artifact(path),
          facts,
          sql,
        });
        const bound = handle.target(fixture.profile.target!);
        const error = yield* Effect.promise(() =>
          bound.inspectTrust().then(
            () => undefined,
            (cause: unknown) => cause,
          ),
        );
        // A later request on the failed session is refused, never retried.
        const later = yield* Effect.promise(() =>
          bound.inspectTrust().then(
            () => undefined,
            (cause: unknown) => cause,
          ),
        );
        yield* handle.shutdown();
        return { error, later, state: handle.state() };
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(failure.error).toMatchObject({ code: "protocolError" });
  expect(failure.later).toBeDefined();
  expect(failure.state).not.toBe("open");
  const { pid } = await fixture.observation();
  cleanup.unshift(async () => killIfAlive(pid));
  expect(pid).toBeGreaterThan(0);
  expect(pidAlive(pid)).toBe(false);
});
