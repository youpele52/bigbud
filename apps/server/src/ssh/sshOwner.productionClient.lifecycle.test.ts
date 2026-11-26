import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import {
  closeSshOwnerAdmissionOnOwnerDeath,
  readSshOwnerAdmission,
  resetSshOwnerProductionStateForTest,
} from "./sshOwnerProductionComposition.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import {
  killIfAlive,
  makeProductionFixture,
  waitFor,
  waitForDeath,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";
import { runLegacyDrain, type LegacyDrainInput, type LegacyDrainPane } from "./sshLegacyDrain.ts";

type Sql = SqlClient.SqlClient;

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => resetSshOwnerProductionStateForTest());
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
    Effect.flatMap(Effect.service(SqlClient.SqlClient), run).pipe(Effect.provide(layer)),
  );
}

const start = (fixture: ProductionFixture, sql: Sql, path: string, profile?: "desktop-packaged") =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact(path, profile),
    facts: resolveSshOwnerLaunchFacts(fixture.profile),
    sql,
  });

const pane = (overrides: Partial<LegacyDrainPane> = {}): LegacyDrainPane => ({
  paneId: "pane-1",
  threadId: "thread-1",
  threadTitle: "Parser work",
  title: "build shell",
  surface: "direct-ssh",
  leaseId: "lease-1",
  keepMode: false,
  ...overrides,
});

describe("production owner client lifecycle", () => {
  it("closes admission on owner death with a typed state and zero legacy launches", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("die");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        handle.onDeath(closeSshOwnerAdmissionOnOwnerDeath);
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
        yield* Effect.promise(() =>
          waitFor(() => readSshOwnerAdmission().kind === "closed", 5_000),
        );
        expect(handle.state()).toBe("dead");
        expect(readSshOwnerAdmission()).toMatchObject({
          kind: "closed",
          step: "owner-attach",
          error: { code: "sshOwnerUnavailable", reason: "owner-died" },
        });
      }),
    );
  });

  it("reaps a non-surviving profile's spawned owner on shutdown", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* handle.shutdown();
        expect(handle.state()).toBe("detached");
        yield* Effect.promise(() => waitForDeath(pid));
      }),
    );
  });

  it("detaches a surviving profile's spawned owner instead of killing it", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path, "desktop-packaged");
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        cleanup.push(async () => killIfAlive(pid));
        yield* handle.shutdown();
        expect(handle.state()).toBe("detached");
        // Give a kill path time to run; the owner must still be alive.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 250)));
        expect(handle.state()).toBe("detached");
        expect(() => process.kill(pid, 0)).not.toThrow();
      }),
    );
  });

  it("leaves drain unchanged: panes close and owned masters exit", async () => {
    const events: string[] = [];
    const closed: string[] = [];
    const input: LegacyDrainInput = {
      trigger: "updater",
      profileScope: "state-dir",
      artifactId: "build-a",
      stopMonitors: Effect.sync(() => events.push("monitors")),
      stopRelays: Effect.sync(() => events.push("relays")),
      stopProviders: Effect.sync(() => events.push("providers")),
      listPanes: Effect.succeed([pane()]),
      consent: () => Effect.succeed({ kind: "proceed", choice: "drain-now" }),
      closePane: (item) =>
        Effect.sync(() => {
          closed.push(`${item.paneId}:${item.leaseId ?? "none"}`);
          events.push(`close:${item.paneId}`);
        }),
      closeOwnedMasters: Effect.sync(() => {
        events.push("masters");
        return { closed: 1, failed: 0 };
      }),
      commit: () =>
        Effect.sync(() => {
          events.push("commit");
        }),
      releaseLock: Effect.sync(() => events.push("release")),
    };
    const outcome = await Effect.runPromise(runLegacyDrain(input));
    expect(outcome.kind).toBe("drained");
    expect(events).toEqual([
      "monitors",
      "relays",
      "providers",
      "close:pane-1",
      "masters",
      "commit",
      "release",
    ]);
    expect(closed).toEqual(["pane-1:lease-1"]);
  });
});
