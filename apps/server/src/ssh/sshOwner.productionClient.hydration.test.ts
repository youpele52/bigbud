import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { commitLegacyRetirement } from "../persistence/Layers/LegacyRetirement.ts";
import { runSshOwnerBootSequence, type SshOwnerProductionOwner } from "./sshOwnerProductionBoot.ts";
import { resolveSshOwnerLaunchFacts } from "./sshOwnerProductionClient.launch.ts";
import { startOrAttachSshOwnerProduction } from "./sshOwnerProductionClient.ts";
import {
  readSshOwnerHydrationSnapshot,
  type SshOwnerHydrationSnapshot,
} from "./sshOwnerProductionHydration.ts";
import {
  killIfAlive,
  makeProductionFixture,
  waitForDeath,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";
import { readSshOwnerStartupState } from "./sshOwnerStartupRefusal.ts";

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
    Effect.flatMap(Effect.service(SqlClient.SqlClient), run).pipe(Effect.provide(layer)),
  );
}

async function prepare(
  fixture: ProductionFixture,
  sql: Sql,
  options: { readonly aliasDescriptor?: Buffer; readonly disconnected?: boolean } = {},
) {
  await Effect.runPromise(
    commitLegacyRetirement(sql, {
      profileScope: fixture.stateDirectory,
      artifactId: "build-a",
      decision: "drain-now",
      drainedLeases: [],
      pendingItems: [],
    }),
  );
  if (options.disconnected) {
    await Effect.runPromise(
      sql`INSERT INTO remote_execution_target_disconnects
        (target_id, disconnected_at) VALUES (${fixture.profile.target!.targetId}, 7)`,
    );
  }
  if (options.aliasDescriptor) {
    await Effect.runPromise(
      sql`INSERT INTO ssh_alias_descriptor_bindings
        (profile_scope, target_id, descriptor_digest, approved_at)
        VALUES (${fixture.stateDirectory}, ${fixture.profile.target!.targetId},
          ${options.aliasDescriptor.toString("hex")}, 7)`,
    );
  }
}

function bootInput(input: {
  fixture: ProductionFixture;
  sql: Sql;
  order: string[];
  start: Effect.Effect<SshOwnerProductionOwner, Error>;
  snapshot?: (sql: Sql) => Effect.Effect<SshOwnerHydrationSnapshot>;
  owner?: (handle: SshOwnerProductionOwner) => void;
}) {
  return {
    acquireStateLock: Effect.sync(() => {
      input.order.push("lock");
    }),
    readState: readSshOwnerStartupState(input.sql, {
      profileScope: input.fixture.stateDirectory,
      ownerPresent: Effect.succeed(true),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          input.order.push("marker");
        }),
      ),
    ),
    startOrAttachOwner: input.start.pipe(
      Effect.tap((handle) =>
        Effect.sync(() => {
          input.order.push("owner");
          input.owner?.(handle);
        }),
      ),
    ),
    hydrate: (handle: SshOwnerProductionOwner) =>
      Effect.gen(function* () {
        input.order.push("hydrate");
        if (input.snapshot) return yield* Effect.flatMap(input.snapshot(input.sql), handle.hydrate);
        return yield* Effect.flatMap(
          readSshOwnerHydrationSnapshot(input.sql, input.fixture.stateDirectory),
          handle.hydrate,
        );
      }),
    openAdmission: () =>
      Effect.sync(() => {
        input.order.push("admission");
      }),
  };
}

describe("production owner client hydration", () => {
  it("validates hydration categories before admission", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const aliasDescriptor = Buffer.alloc(32, 5);
    // A multi-target owner reports no alias descriptor at startup; each target
    // is hydrated before its first request.
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => prepare(fixture, sql, { aliasDescriptor, disconnected: true }));
        const order: string[] = [];
        let pid = 0;
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({
            fixture,
            sql,
            order,
            start: startOrAttachSshOwnerProduction({
              artifact: fixture.artifact(path),
              facts: resolveSshOwnerLaunchFacts(fixture.profile),
              sql,
            }),
            owner: () => undefined,
          }),
        );
        expect(outcome.kind).toBe("open");
        expect(order).toEqual(["lock", "marker", "owner", "hydrate", "admission"]);
        pid = (yield* Effect.promise(() => fixture.observation())).pid;
        cleanup.push(async () => killIfAlive(pid));
      }),
    );
  });

  it("keeps admission closed while a retirement mirror row is unresolved", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => prepare(fixture, sql));
        const order: string[] = [];
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({
            fixture,
            sql,
            order,
            start: startOrAttachSshOwnerProduction({
              artifact: fixture.artifact(path),
              facts: resolveSshOwnerLaunchFacts(fixture.profile),
              sql,
            }),
            snapshot: () =>
              Effect.sync(() => ({
                durableDisconnects: [],
                aliasDescriptorBindings: [],
                retirementMirror: [
                  {
                    profileScope: fixture.stateDirectory,
                    targetId: fixture.profile.target!.targetId,
                    ownerEpoch: "epoch",
                    generation: "gen",
                    state: "intent" as const,
                    pid: 7,
                    startTime: "1",
                    namespace: null,
                    detail: "prior owner intent",
                    updatedAt: 1,
                  },
                ],
                paneBindings: [],
              })),
          }),
        );
        expect(outcome.kind).toBe("unavailable");
        if (outcome.kind === "unavailable") {
          expect(outcome.step).toBe("hydrate");
          expect(outcome.error.reason).toBe("hydration-failed");
        }
        expect(order).not.toContain("admission");
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
      }),
    );
  });

  it("reaps a spawned owner when a direct pane binding is unresolved", async () => {
    const fixture = await makeProductionFixture();
    cleanup.push(fixture.dispose);
    const path = await fixture.fakeOwner("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => prepare(fixture, sql));
        const order: string[] = [];
        let handle: SshOwnerProductionOwner | undefined;
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({
            fixture,
            sql,
            order,
            start: startOrAttachSshOwnerProduction({
              artifact: fixture.artifact(path),
              facts: resolveSshOwnerLaunchFacts(fixture.profile),
              sql,
            }),
            snapshot: () =>
              Effect.succeed({
                durableDisconnects: [],
                aliasDescriptorBindings: [],
                retirementMirror: [],
                paneBindings: [
                  {
                    ownerKey: "pane-1",
                    threadId: "thread-1",
                    terminalId: "terminal-1",
                    ownerEpoch: "",
                    targetId: fixture.profile.target!.targetId,
                    generation: "",
                    leaseId: "reservation-1",
                    state: "may-have-been-sent",
                  },
                ],
              }),
            owner: (started) => {
              handle = started;
            },
          }),
        );
        expect(outcome.kind).toBe("unavailable");
        if (outcome.kind === "unavailable") {
          expect(outcome.step).toBe("hydrate");
          expect(outcome.error.reason).toBe("hydration-failed");
        }
        expect(order).not.toContain("admission");
        expect(handle).toBeDefined();
        const production = handle as unknown as { state: () => string };
        expect(production.state()).toBe("detached");
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
      }),
    );
  });
});
