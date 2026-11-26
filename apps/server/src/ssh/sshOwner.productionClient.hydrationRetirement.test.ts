import { readFile } from "node:fs/promises";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  killIfAlive,
  makeProductionFixture,
  waitForDeath,
  type ProductionFixture,
} from "./sshOwnerProductionClient.fixture.ts";
import {
  bootInput,
  markBuildADrained,
  runBoot,
  withPersistence,
  type Sql,
} from "./sshOwner.productionClient.hydration.fixture.ts";
import { runSshOwnerBootSequence } from "./sshOwnerProductionBoot.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const seedRetirement = (fixture: ProductionFixture, sql: Sql) =>
  Effect.runPromise(
    sql`INSERT INTO ssh_owner_retirement
      (profile_scope, target_id, owner_epoch, generation, state, pid, start_time, namespace,
        detail, updated_at)
      VALUES (${fixture.stateDirectory}, ${fixture.profile.target!.targetId}, '',
        '', 'intent', NULL, NULL, NULL, 'pre-spawn intent', 7)`,
  );

const activity = async (fixture: ProductionFixture) =>
  readFile(fixture.activityFile, "utf8").catch(() => "");

async function prepare(mode: Parameters<ProductionFixture["fakeOwner"]>[0]) {
  const fixture = await makeProductionFixture();
  cleanup.push(fixture.dispose);
  const path = await fixture.fakeOwner(mode);
  return { fixture, path };
}

describe("production owner retirement reconciliation", () => {
  it("sends unresolved retirement rows and opens only after the owner acknowledgement", async () => {
    const { fixture, path } = await prepare("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        yield* Effect.promise(() => seedRetirement(fixture, sql));
        const order: string[] = [];
        const outcome = yield* runBoot({ fixture, sql, order, ownerPath: path });
        expect(outcome.kind).toBe("open");
        expect(order).toEqual(["lock", "marker", "owner", "hydrate", "admission"]);
        expect(yield* Effect.promise(() => activity(fixture))).toContain(
          "reconcile retirements=1 panes=0",
        );
        if (outcome.kind === "open") yield* outcome.owner.shutdown?.() ?? Effect.void;
      }),
    );
  });

  it("refuses admission when the owner cannot verify an unresolved retirement row", async () => {
    const { fixture, path } = await prepare("reconcile-retirement");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        yield* Effect.promise(() => seedRetirement(fixture, sql));
        const order: string[] = [];
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({ fixture, sql, order, ownerPath: path }),
        );
        expect(outcome.kind).toBe("unavailable");
        if (outcome.kind === "unavailable") {
          expect(outcome.step).toBe("owner-attach");
          expect(outcome.error.reason).toBe("retirement-unverifiable");
        }
        expect(order).not.toContain("admission");
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
      }),
    );
  });

  it("refuses a stale acknowledgement from a previous reconciliation round", async () => {
    const { fixture, path } = await prepare("reconcile-stale");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        const order: string[] = [];
        const outcome = yield* runBoot({ fixture, sql, order, ownerPath: path });
        expect(outcome.kind).toBe("unavailable");
        if (outcome.kind === "unavailable") {
          expect(outcome.error.reason).toBe("owner-protocol-invalid");
        }
        expect(order).not.toContain("admission");
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
      }),
    );
  });

  it("keeps admission closed when the acknowledgement is partial", async () => {
    const { fixture, path } = await prepare("reconcile-partial");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        yield* Effect.promise(() => seedRetirement(fixture, sql));
        const order: string[] = [];
        let pid = 0;
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({ fixture, sql, order, ownerPath: path }),
        );
        expect(outcome.kind).toBe("unavailable");
        if (outcome.kind === "unavailable") {
          expect(outcome.step).toBe("hydrate");
          expect(outcome.error.reason).toBe("hydration-failed");
        }
        expect(order).not.toContain("admission");
        pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
        cleanup.push(async () => killIfAlive(pid));
      }),
    );
  });
});
