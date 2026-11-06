import { fileURLToPath } from "node:url";

import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";

import { makeWorkerConnection } from "./NodeSqliteClient.worker.ts";
import {
  NodeSqliteWorkerBridge,
  waitForNodeSqliteWorkersIdle,
} from "./NodeSqliteClient.worker.bridge.ts";

const fixtureEntry = fileURLToPath(
  new URL("./NodeSqliteWorker.crash.fixture.mjs", import.meta.url),
);
const openOptions = (behaviour: string) => ({
  filename: behaviour,
  readonly: false,
  allowExtension: false,
  prepareCacheSize: 10,
});

it("waits for the worker to exit after an unacknowledged close", async () => {
  const bridge = new NodeSqliteWorkerBridge(fixtureEntry, openOptions("ignore-close"), {
    openTimeoutMs: 5_000,
    closeTimeoutMs: 100,
    exitTimeoutMs: 5_000,
  });
  await bridge.open();
  const startedAt = performance.now();
  await bridge.close();
  // Resolved only after the close deadline and after the thread actually exited.
  assert.isAtLeast(performance.now() - startedAt, 90);
  assert.match(bridge.failure?.message ?? "", /exited with code/);
});

it("closes promptly and fully when the worker acknowledges close", async () => {
  const bridge = new NodeSqliteWorkerBridge(fixtureEntry, openOptions("crash"));
  await bridge.open();
  await bridge.close();
  assert.match(bridge.failure?.message ?? "", /exited with code/);
});

it.live(
  "reports a stuck open as a ConnectionError instead of waiting for the desktop deadline",
  () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeWorkerConnection(fixtureEntry, openOptions("never-ready"), {
          openTimeoutMs: 150,
          closeTimeoutMs: 100,
          exitTimeoutMs: 2_000,
        }),
      ).pipe(Effect.timeout("10 seconds"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const defect = Cause.squash(exit.cause) as { readonly reason?: { readonly _tag: string } };
        assert.equal(defect.reason?._tag, "ConnectionError");
        assert.match(String(Cause.pretty(exit.cause)), /did not open the database within 150 ms/);
      }
    }).pipe(Effect.scoped),
);

it("reports idle once no worker request is in flight", async () => {
  const bridge = new NodeSqliteWorkerBridge(fixtureEntry, openOptions("crash"));
  await bridge.open();
  const answered = new Promise<void>((resolve) =>
    bridge.execute(
      { kind: "execute", sql: "SELECT 1", params: [], mode: "rows", safeIntegers: false },
      () => resolve(),
    ),
  );
  await waitForNodeSqliteWorkersIdle({ quietMs: 10, timeoutMs: 2_000 });
  await answered;
  assert.equal(bridge.pendingCount, 0);
  await bridge.close();
});

it("reports a crash of an open worker once, but never a close or a failed open", async () => {
  const failures: string[] = [];
  const hooks = { onUnexpectedFailure: (f: { message: string }) => failures.push(f.message) };
  const crashed = new NodeSqliteWorkerBridge(fixtureEntry, openOptions("crash"), undefined, hooks);
  await crashed.open();
  await new Promise<void>((resolve) =>
    crashed.execute(
      { kind: "execute", sql: "CRASH", params: [], mode: "rows", safeIntegers: false },
      () => resolve(),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    failures.map((message) => message.replace(/:.*$/, "")),
    ["SQLite worker crashed"],
  );
  await crashed.close();

  const closed = new NodeSqliteWorkerBridge(fixtureEntry, openOptions("crash"), undefined, hooks);
  await closed.open();
  await closed.close();
  const neverReady = new NodeSqliteWorkerBridge(
    fixtureEntry,
    openOptions("never-ready"),
    { openTimeoutMs: 100, closeTimeoutMs: 100, exitTimeoutMs: 2_000 },
    hooks,
  );
  await neverReady.open().catch(() => undefined);
  await neverReady.close();
  assert.equal(failures.length, 1);
});
