import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, assert, it } from "vitest";

import { runtimeArchiveKeyForManifest } from "./runtimeArchive.key.ts";
import { signedManifest } from "./runtimeArchive.test.helpers.ts";
import { stepError } from "./runtimeUpdate.activate.context.ts";
import {
  makeActivationHarness,
  operationState,
  stagedEntryPath,
  startBackendProcess,
  waitFor,
  type BackendProcess,
} from "./runtimeUpdate.activate.test.helpers.ts";
import { readRuntimeUpdateJournal, runtimeUpdateBackupPath } from "./runtimeUpdate.journal.ts";
import { uuid } from "./runtimeUpdate.test.helpers.ts";
import { makeRuntimeUpdateServiceUnit } from "./runtimeUpdate.unit.ts";
import { RemoteRuntimeUpdate } from "./Services/RemoteRuntimeUpdate.ts";

const cleanup: Array<string> = [];
const processes: Array<BackendProcess> = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.dispose()));
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
const OLD_ENTRY = "/opt/previous-runtime/entry.mjs";
const key = runtimeArchiveKeyForManifest(signedManifest("2.0.0"));
const start = async (...args: Parameters<typeof startBackendProcess>) => {
  const process = await startBackendProcess(...args);
  processes.push(process);
  return process;
};
const stop = async (process: BackendProcess) => {
  processes.splice(processes.indexOf(process), 1);
  await process.dispose();
};
const requestUpdate = (process: BackendProcess) =>
  process.run(
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
const sql = (process: BackendProcess, statement: string) =>
  process.run(
    Effect.gen(function* () {
      return yield* (yield* SqlClient.SqlClient).unsafe(statement);
    }),
  );

it("disk_full_refused_before_outage", async () => {
  const h = await makeActivationHarness(cleanup);
  h.availableBytes = 1024;
  const backend = await start(h, { runningEntry: () => OLD_ENTRY });
  await requestUpdate(backend);
  await waitFor(async () => (await operationState(backend))?.state === "failed");
  const operation = await operationState(backend);
  assert.match(operation!.failure!, /Not enough disk space.*Nothing was stopped/);
  // Refused before any outage: admission never closed, nothing switched, no backup, key released.
  assert.equal(backend.gate.closes, 0);
  assert.deepStrictEqual(h.unit.calls, []);
  assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
  const backup = runtimeUpdateBackupPath(h.stateDir, operation!.operationId);
  assert.isFalse(
    await fs.stat(backup).then(
      () => true,
      () => false,
    ),
  );
  // The reservation is released right after the failure is persisted.
  await waitFor(async () => !(await h.base.pointer()).pending.includes(key));
});

it("failed_trial_rolls_back_without_ack_loss", async () => {
  const h = await makeActivationHarness(cleanup);
  const old = await start(h, { runningEntry: () => OLD_ENTRY });
  await sql(old, "CREATE TABLE acks (command_id TEXT PRIMARY KEY)");
  await sql(old, "INSERT INTO acks VALUES ('acknowledged-before-update')");
  await requestUpdate(old);
  await waitFor(() => h.unit.calls.includes("restart"));
  assert.equal((await operationState(old))?.state, "activating");
  assert.isTrue(old.gate.isClosed(), "admission stays closed until the process is replaced");
  assert.equal((await readRuntimeUpdateJournal(h.stateDir))?.phase, "restarting");
  await stop(old);

  // The new runtime migrates the database forward, then fails its trial before admitting work.
  const db = new DatabaseSync(h.dbPath);
  db.exec("INSERT INTO acks VALUES ('written-by-new-runtime')");
  db.close();
  const trial = await start(h, {
    runningEntry: () => stagedEntryPath(h, "2.0.0"),
    trial: Effect.fail(stepError("Trial readiness failed: simulated provider registry crash.")),
  });
  assert.isTrue(trial.gate.isClosed(), "a runtime on trial starts with admission closed");
  await waitFor(() => h.unit.calls.filter((call) => call === "restart").length === 2);
  assert.equal(trial.gate.admitted(), 0);
  assert.equal((await readRuntimeUpdateJournal(h.stateDir))?.phase, "restore-pending");
  assert.deepStrictEqual(h.unit.calls, ["pointAt", "restart", "restore", "restart"]);
  assert.equal(h.unit.config, "config:previous");
  await stop(trial);

  // The previous runtime restores the offline backup before opening the database.
  const restored = await start(h, { runningEntry: () => OLD_ENTRY });
  await waitFor(async () => (await operationState(restored))?.state === "failed");
  const operation = await operationState(restored);
  assert.match(operation!.failure!, /simulated provider registry crash.*Rolled back/);
  const rows = await sql(restored, "SELECT command_id FROM acks ORDER BY command_id");
  assert.deepStrictEqual(rows, [{ command_id: "acknowledged-before-update" }]);
  await waitFor(() => !restored.gate.isClosed());
  assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
  const pointer = await h.base.pointer();
  assert.notInclude(pointer.pending, key);
  assert.notEqual(pointer.active, key);
});

it("rust_terminal_pid_unchanged", async () => {
  const h = await makeActivationHarness(cleanup);
  // Stand-in for a terminal owned by the independent Rust unit.
  const terminal = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  const pid = terminal.pid!;
  const argv: Array<ReadonlyArray<string>> = [];
  const realUnit = makeRuntimeUpdateServiceUnit({
    homeDir: "/home/fixture",
    authorityId: "a".repeat(32),
    exec: async (_file, args) => {
      argv.push(args);
    },
  });
  h.unit.onRestart = () => realUnit.restart();
  try {
    h.base.work.push({ kind: "turn", id: "thread-1#turn", label: "busy" });
    const old = await start(h, { runningEntry: () => OLD_ENTRY });
    await requestUpdate(old);
    await waitFor(async () => (await operationState(old))?.state === "deferred");
    h.base.work.splice(0);
    await waitFor(() => h.unit.calls.includes("restart"));
    await stop(old);
    const next = await start(h, { runningEntry: () => stagedEntryPath(h, "2.0.0") });
    await waitFor(async () => (await operationState(next))?.state === "activated");
    await waitFor(() => !next.gate.isClosed());
    assert.equal((await h.base.pointer()).active, key);
    assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
    // Only the backend unit was restarted; the Rust unit's process kept its PID.
    assert.deepStrictEqual(argv, [
      [
        "--user",
        "--no-pager",
        "--no-ask-password",
        "--no-block",
        "restart",
        `bigbud-backend-${"a".repeat(32)}.service`,
      ],
    ]);
    assert.isTrue(process.kill(pid, 0));
    assert.equal(terminal.exitCode, null);
  } finally {
    terminal.kill("SIGKILL");
  }
});

it("downgrade_refused_before_outage", async () => {
  const h = await makeActivationHarness(cleanup);
  const backend = await start(h, { runningEntry: () => OLD_ENTRY, runningVersion: "2.1.0" });
  await requestUpdate(backend);
  await waitFor(async () => (await operationState(backend))?.state === "failed");
  assert.match((await operationState(backend))!.failure!, /Downgrading from 2\.1\.0 to 2\.0\.0/);
  assert.equal(backend.gate.closes, 0);
  assert.deepStrictEqual(h.unit.calls, []);
  await waitFor(async () => !(await h.base.pointer()).pending.includes(key));
});
