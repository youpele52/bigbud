/**
 * The previous runtime finishes a rollback that the Rust launcher started (`rollback.rs`): the
 * switched runtime never started, so the launcher restored the previous pins and left the
 * journal `restore-pending`. The database restore and the failed settlement stay here.
 */
import * as fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, assert, it } from "vitest";

import { runtimeArchiveKeyForManifest } from "./runtimeArchive.key.ts";
import { signedManifest } from "./runtimeArchive.test.helpers.ts";
import {
  makeActivationHarness,
  operationState,
  stagedEntryPath,
  startBackendProcess,
  waitFor,
  type ActivationHarness,
  type BackendProcess,
} from "./runtimeUpdate.activate.test.helpers.ts";
import {
  readRuntimeUpdateJournal,
  runtimeUpdateJournalPath,
  runtimeUpdateLaunchAttemptsPath,
} from "./runtimeUpdate.journal.ts";
import { uuid } from "./runtimeUpdate.test.helpers.ts";
import { RemoteRuntimeUpdate } from "./Services/RemoteRuntimeUpdate.ts";

const cleanup: Array<string> = [];
const processes: Array<BackendProcess> = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.dispose()));
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
const OLD_ENTRY = "/opt/previous-runtime/entry.mjs";
const key = runtimeArchiveKeyForManifest(signedManifest("2.0.0"));
const LAUNCHER_FAILURE =
  "The new runtime did not start after 3 launches; the launcher restored the previous runtime.";
const HALF_SWITCHED =
  "The runtime switch stopped between the receipt and the config; the launcher restored the previous runtime.";

const start = async (...args: Parameters<typeof startBackendProcess>) => {
  const process = await startBackendProcess(...args);
  processes.push(process);
  return process;
};
const stop = async (process: BackendProcess) => {
  processes.splice(processes.indexOf(process), 1);
  await process.dispose();
};
const sql = (process: BackendProcess, statement: string) =>
  process.run(
    Effect.gen(function* () {
      return yield* (yield* SqlClient.SqlClient).unsafe(statement);
    }),
  );
const exists = (path: string) =>
  fs.stat(path).then(
    () => true,
    () => false,
  );

/** The old runtime drains, backs up, switches and requests its restart, then stops. */
async function switchAway(h: ActivationHarness) {
  const old = await start(h, { runningEntry: () => OLD_ENTRY });
  await sql(old, "CREATE TABLE acks (command_id TEXT PRIMARY KEY)");
  await sql(old, "INSERT INTO acks VALUES ('acknowledged-before-update')");
  await old.run(
    Effect.gen(function* () {
      const update = yield* RemoteRuntimeUpdate;
      yield* update.request({
        requestId: uuid(1),
        version: "2.0.0",
        source: "release",
        interrupt: false,
      });
    }),
  );
  await waitFor(() => h.unit.calls.includes("restart"));
  assert.equal((await readRuntimeUpdateJournal(h.stateDir))?.phase, "restarting");
  await stop(old);
}

/** What the launcher writes: the journal re-serialised with sorted keys, phase and failure set. */
async function launcherRollsBack(h: ActivationHarness, failure: string) {
  const journal = (await readRuntimeUpdateJournal(h.stateDir))!;
  h.unit.config = journal.previousConfig;
  h.unit.receipt = journal.previousReceipt;
  const value: Record<string, unknown> = { ...journal, phase: "restore-pending", failure };
  const sorted = Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((name) => [name, value[name]]),
  );
  await fs.writeFile(runtimeUpdateJournalPath(h.stateDir), `${JSON.stringify(sorted)}\n`, {
    mode: 0o600,
  });
}

for (const [name, failure] of [
  ["never_started_runtime_rolls_back_through_the_launcher", LAUNCHER_FAILURE],
  ["half_switched_pair_rolls_back_through_the_launcher", HALF_SWITCHED],
] as const) {
  it(name, async () => {
    const h = await makeActivationHarness(cleanup);
    await switchAway(h);
    // The switched runtime crashed at once on every launch; a write it made never survives.
    const db = new DatabaseSync(h.dbPath);
    db.exec("INSERT INTO acks VALUES ('written-by-crashed-runtime')");
    db.close();
    await launcherRollsBack(h, failure);

    const previous = await start(h, { runningEntry: () => OLD_ENTRY });
    await waitFor(async () => (await operationState(previous))?.state === "failed");
    const operation = await operationState(previous);
    assert.include(operation!.failure!, failure);
    assert.include(operation!.failure!, "Rolled back to the previous runtime and database backup");
    const rows = await sql(previous, "SELECT command_id FROM acks ORDER BY command_id");
    assert.deepStrictEqual(rows, [{ command_id: "acknowledged-before-update" }]);
    await waitFor(() => !previous.gate.isClosed());
    assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
    // The launcher switched the pins; the backend neither restored nor restarted again.
    assert.deepStrictEqual(h.unit.calls, ["pointAt", "restart"]);
    assert.equal(h.unit.config, "config:previous");
    const pointer = await h.base.pointer();
    assert.notInclude(pointer.pending, key);
    assert.notEqual(pointer.active, key);
  });
}

it("activation_clears_the_launch_counter_before_admission", async () => {
  const h = await makeActivationHarness(cleanup);
  await switchAway(h);
  // Two launches of the new runtime failed before this one.
  await fs.writeFile(runtimeUpdateLaunchAttemptsPath(h.stateDir), "op\nsha\n2\n", { mode: 0o600 });
  const next = await start(h, { runningEntry: () => stagedEntryPath(h, "2.0.0") });
  await waitFor(async () => (await operationState(next))?.state === "activated");
  await waitFor(() => !next.gate.isClosed());
  assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
  assert.isFalse(await exists(runtimeUpdateLaunchAttemptsPath(h.stateDir)));
});
