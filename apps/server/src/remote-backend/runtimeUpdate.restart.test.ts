import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { afterEach, assert, it } from "vitest";

import {
  makeActivationHarness,
  operationState,
  stagedEntryPath,
  startBackendProcess,
  waitFor,
  type BackendProcess,
} from "./runtimeUpdate.activate.test.helpers.ts";
import { readRuntimeUpdateJournal } from "./runtimeUpdate.journal.ts";
import { uuid } from "./runtimeUpdate.test.helpers.ts";
import { makeRuntimeUpdateServiceUnit, RuntimeUnitRestartRefused } from "./runtimeUpdate.unit.ts";
import { RemoteRuntimeUpdate } from "./Services/RemoteRuntimeUpdate.ts";

const cleanup: Array<string> = [];
const processes: Array<BackendProcess> = [];
afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.dispose()));
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
const OLD_ENTRY = "/opt/previous-runtime/entry.mjs";
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
      yield* (yield* RemoteRuntimeUpdate).request({
        requestId: uuid(1),
        version: "2.0.0",
        source: "release",
        interrupt: false,
      });
    }),
  );
/** A real unit whose systemd-run child fails the given way. */
const unitFailing = (failure: object) =>
  makeRuntimeUpdateServiceUnit({
    homeDir: "/home/fixture",
    authorityId: "a".repeat(32),
    exec: async () => {
      throw Object.assign(new Error("Command failed"), failure);
    },
  });

it("classifies a killed or timed-out requester as unconfirmed and an exit status as refused", async () => {
  assert.equal(await unitFailing({ signal: "SIGTERM", code: null }).restart(), "unconfirmed");
  assert.equal(await unitFailing({ killed: true, signal: null }).restart(), "unconfirmed");
  const refused = await unitFailing({ code: 1, signal: null })
    .restart()
    .then(
      () => undefined,
      (cause: unknown) => cause,
    );
  assert.instanceOf(refused, RuntimeUnitRestartRefused);
});

it("restart_request_killed_mid_flight_never_restores_and_the_trial_decides", async () => {
  const h = await makeActivationHarness(cleanup);
  // The requester is SIGTERMed as the unit stops (KillMode=control-group): a restart is in flight.
  h.unit.onRestart = () => unitFailing({ signal: "SIGTERM", code: null }).restart();
  const old = await start(h, { runningEntry: () => OLD_ENTRY });
  await requestUpdate(old);
  await waitFor(() => h.unit.calls.includes("restart"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notInclude(h.unit.calls, "restore");
  assert.equal(h.unit.config, `config:${stagedEntryPath(h, "2.0.0")}`);
  assert.equal((await operationState(old))?.state, "activating");
  assert.equal((await readRuntimeUpdateJournal(h.stateDir))?.phase, "restarting");
  await stop(old);
  const next = await start(h, { runningEntry: () => stagedEntryPath(h, "2.0.0") });
  await waitFor(async () => (await operationState(next))?.state === "activated");
  assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
});

it("restart_request_refused_restores_before_any_restart", async () => {
  const h = await makeActivationHarness(cleanup);
  h.unit.onRestart = () => unitFailing({ code: 1, signal: null }).restart();
  const old = await start(h, { runningEntry: () => OLD_ENTRY });
  await requestUpdate(old);
  await waitFor(async () => (await operationState(old))?.state === "failed");
  assert.deepStrictEqual(h.unit.calls, ["pointAt", "restart", "restore"]);
  assert.equal(h.unit.config, "config:previous");
  assert.match((await operationState(old))!.failure!, /failed before the restart.*refused/);
  assert.isNull(await readRuntimeUpdateJournal(h.stateDir));
  await waitFor(() => !old.gate.isClosed());
});

it("a runtime that is not restarted repeats the request and never restores", async () => {
  const h = await makeActivationHarness(cleanup);
  const old = await start(h, { runningEntry: () => OLD_ENTRY, restartGraceMs: 20 });
  await requestUpdate(old);
  await waitFor(() => h.unit.calls.filter((call) => call === "restart").length >= 3);
  assert.notInclude(h.unit.calls, "restore");
  assert.equal((await readRuntimeUpdateJournal(h.stateDir))?.phase, "restarting");
  assert.isTrue(old.gate.isClosed());
});
