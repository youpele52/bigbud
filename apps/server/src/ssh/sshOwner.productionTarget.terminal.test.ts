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

const terminal = {
  cwd: "/home/fixture/project",
  threadId: "thread-fixture",
  terminalId: "terminal-fixture",
  cols: 80,
  rows: 24,
};

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

const start = (fixture: ProductionFixture, sql: Sql, path: string) =>
  startOrAttachSshOwnerProduction({
    artifact: fixture.artifact(path),
    facts: resolveSshOwnerLaunchFacts(fixture.profile),
    sql,
  });

/**
 * These cases run the production client against the disposable fake owner, so
 * they cover the wire/lease path without a live SSH host. Live master/PTY
 * evidence stays in the host-gated Rust fixture test.
 */
describe("production owner terminal provider", () => {
  it("round-trips a reserved terminal through the production client", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const target = handle.target(fixture.profile.target!);
        yield* Effect.promise(() => target.inspectTrust());

        const reservation = yield* Effect.promise(() => target.prepareProofTerminal(terminal));
        expect(reservation.lease).toHaveLength(32);
        const opened = yield* Effect.promise(() =>
          target.openReservedProofTerminal(reservation.lease),
        );
        expect(opened.live).toBe(true);

        const written = yield* Effect.promise(() =>
          target.writeProofTerminalInput(
            reservation.lease,
            1,
            new TextEncoder().encode("printf ready\n"),
          ),
        );
        expect(written.live).toBe(true);
        yield* Effect.promise(() => target.resizeProofTerminal(reservation.lease, 120, 40));
        const replay = yield* Effect.promise(() =>
          target.replayProofTerminal(reservation.lease, 0),
        );
        expect(replay.lease).toEqual(reservation.lease);
        expect(replay.chunks.length).toBeGreaterThan(0);

        const closed = yield* Effect.promise(() => target.closeProofTerminal(reservation.lease));
        expect(closed.live).toBe(false);

        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("never opens the empty fixture lease in production", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const target = handle.target(fixture.profile.target!);
        yield* Effect.promise(() => target.inspectTrust());
        // Production requires reservation-before-dispatch; the fixed proof
        // command has no empty-lease path on a real target.
        yield* Effect.promise(() =>
          expect(target.openProofTerminal()).rejects.toMatchObject({ code: "operationDenied" }),
        );
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("keeps one target's terminal lease invisible to another target", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const first = handle.target(fixture.profile.target!);
        const second = handle.target({
          ...fixture.profile.target!,
          targetId: "ssh:host=second&auth=ssh-key&transport=direct-ssh",
        });
        yield* Effect.promise(() => first.inspectTrust());
        yield* Effect.promise(() => second.inspectTrust());

        const reservation = yield* Effect.promise(() => first.prepareProofTerminal(terminal));
        yield* Effect.promise(() => first.openReservedProofTerminal(reservation.lease));
        // The second target has no such lease; its own lanes do not inherit it.
        yield* Effect.promise(() =>
          expect(second.closeProofTerminal(reservation.lease)).rejects.toMatchObject({
            code: "operationDenied",
          }),
        );
        const status = yield* Effect.promise(() => first.proofTerminalStatus(reservation.lease));
        expect(status.live).toBe(true);
        yield* Effect.promise(() => first.closeProofTerminal(reservation.lease));

        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a terminal request for a target whose policy fails before any request", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const rejected = "ssh:host=unsupported&auth=ssh-key&transport=direct-ssh";
    const path = await fixture.fakeOwner("policy-refusal", { rejectTarget: rejected });
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        const handle = yield* start(fixture, sql, path);
        const target = handle.target({ ...fixture.profile.target!, targetId: rejected });
        yield* Effect.promise(() =>
          expect(target.prepareProofTerminal(terminal)).rejects.toMatchObject({
            code: "configUnsupported",
          }),
        );
        // The refused target never reached a request frame (no dial, no lane).
        const activity = yield* Effect.promise(() => readFile(fixture.activityFile, "utf8"));
        expect(activity).toContain(`grant ${rejected}`);
        expect(activity).not.toContain(`request ${rejected}`);
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });

  it("refuses a terminal request for a stale generation before any request", async () => {
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
          targetId: "ssh:stale-terminal&auth=ssh-key&transport=direct-ssh",
          generation: bytes(0x99),
        });
        yield* Effect.promise(() =>
          expect(stale.prepareProofTerminal(terminal)).rejects.toMatchObject({
            code: "staleGeneration",
          }),
        );
        const activity = yield* Effect.promise(() => readFile(fixture.activityFile, "utf8"));
        expect(activity).not.toContain("request ssh:stale-terminal");
        yield* Effect.promise(() => fresh.inspectTrust());
        const observation = yield* Effect.promise(() => fixture.observation());
        yield* handle.shutdown();
        cleanup.push(async () => killIfAlive(observation.pid));
      }),
    );
  });
});
