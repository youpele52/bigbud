import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "./Sqlite.ts";
import { withRemoteExecutionTargetDisconnects } from "./RemoteExecutionTargetDisconnects.ts";
import {
  clearSshTargetDisconnected,
  configureSshTargetDisconnects,
  isSshTargetDisconnected,
  listDisconnectedSshTargets,
  markSshTargetDisconnected,
} from "../../ssh/sshTargetDisconnects.ts";

const target = "ssh:host=box&auth=ssh-key&transport=agent";
const directTarget = "ssh:host=box&auth=password&transport=direct-ssh";
const temporaryDirectories: string[] = [];

afterEach(() => {
  configureSshTargetDisconnects(undefined, []);
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function persistenceAt(dbPath: string) {
  return withRemoteExecutionTargetDisconnects(
    makeSqlitePersistenceLive(dbPath, { worker: false }),
  ).pipe(Layer.provide(NodeServices.layer));
}

it("keeps disconnects across a restart and loads them before SqlClient consumers build", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-disconnects-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "state.sqlite");

  // First server run: the user disconnects two targets and connects one again.
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{
        name: string;
        notnull: number;
        pk: number;
      }>`PRAGMA table_info(remote_execution_target_disconnects)`;
      expect(columns.map(({ name, notnull, pk }) => ({ name, notnull, pk }))).toEqual([
        { name: "target_id", notnull: 1, pk: 1 },
        { name: "disconnected_at", notnull: 1, pk: 0 },
      ]);
      yield* Effect.promise(() => markSshTargetDisconnected(target));
      yield* Effect.promise(() => markSshTargetDisconnected(directTarget));
      yield* Effect.promise(() => clearSshTargetDisconnected(directTarget));
    }).pipe(Effect.provide(persistenceAt(dbPath))),
  );

  // Process restart: memory starts empty.
  configureSshTargetDisconnects(undefined, []);
  expect(isSshTargetDisconnected(target)).toBe(false);

  // A dependent layer stands in for remote-agent startup maintenance and the scheduler:
  // it receives SqlClient from the wrapped persistence and must already see the flag.
  let observedAtConstruction: boolean | undefined;
  const startupConsumer = Layer.effectDiscard(
    Effect.gen(function* () {
      yield* SqlClient.SqlClient;
      observedAtConstruction = isSshTargetDisconnected(target);
    }),
  );
  await Effect.runPromise(
    Effect.void.pipe(
      Effect.provide(startupConsumer.pipe(Layer.provideMerge(persistenceAt(dbPath)))),
    ),
  );
  expect(observedAtConstruction).toBe(true);
  expect(listDisconnectedSshTargets()).toEqual([target]);
});
