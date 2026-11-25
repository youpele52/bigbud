import { readFile } from "node:fs/promises";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ProductionFixture } from "./sshOwnerProductionClient.fixture.ts";
import { makeProductionFixture, waitForDeath } from "./sshOwnerProductionClient.fixture.ts";
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

const ownerKey = `terminal:${"b".repeat(64)}`;

const hostedRecord = (targetId: string) =>
  JSON.stringify({
    version: 2,
    kind: "local-terminal-host",
    pane: { threadId: "thread-1", terminalId: "terminal-1" },
    ownerKey,
    reservationId: "reservation-1",
    controllerId: "controller-1",
    executionTargetId: targetId,
    state: "may-have-been-sent",
  });

const seedPane = (fixture: ProductionFixture, sql: Sql, json: string) =>
  Effect.runPromise(
    sql`INSERT INTO direct_shell_launch_owners
      (owner_key, reservation_id, controller_id, state, owner_json)
      VALUES (${ownerKey}, 'reservation-1', 'controller-1', 'may-have-been-sent', ${json})`,
  );

const activity = async (fixture: ProductionFixture) =>
  readFile(fixture.activityFile, "utf8").catch(() => "");

async function prepare(mode: Parameters<ProductionFixture["fakeOwner"]>[0]) {
  const fixture = await makeProductionFixture();
  cleanup.push(fixture.dispose);
  const path = await fixture.fakeOwner(mode);
  return { fixture, path };
}

describe("production owner pane reconciliation", () => {
  it("sends retained pane bindings and opens only after the owner acknowledgement", async () => {
    const { fixture, path } = await prepare("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        yield* Effect.promise(() =>
          seedPane(fixture, sql, hostedRecord(fixture.profile.target!.targetId)),
        );
        const order: string[] = [];
        const outcome = yield* runBoot({ fixture, sql, order, ownerPath: path });
        expect(outcome.kind).toBe("open");
        expect(yield* Effect.promise(() => activity(fixture))).toContain(
          "reconcile retirements=0 panes=1",
        );
        if (outcome.kind === "open") yield* outcome.owner.shutdown?.() ?? Effect.void;
      }),
    );
  });

  it("refuses admission when the owner cannot recover a malformed pane binding", async () => {
    const { fixture, path } = await prepare("reconcile-pane");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        // Legacy record without an execution target: the owner cannot recover it.
        yield* Effect.promise(() =>
          seedPane(
            fixture,
            sql,
            JSON.stringify({ version: 1, reservationId: "reservation-1", intent: {} }),
          ),
        );
        const order: string[] = [];
        const outcome = yield* runBoot({ fixture, sql, order, ownerPath: path });
        expect(outcome.kind).toBe("unavailable");
        if (outcome.kind === "unavailable") {
          expect(outcome.error.reason).toBe("pane-unrecoverable");
        }
        expect(order).not.toContain("admission");
        const pid = (yield* Effect.promise(() => fixture.observation())).pid;
        yield* Effect.promise(() => waitForDeath(pid));
      }),
    );
  });

  it("keeps an uncertain reservation retained instead of failing admission locally", async () => {
    const { fixture, path } = await prepare("success");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        yield* sql`INSERT INTO direct_shell_launch_owners
            (owner_key, reservation_id, controller_id, state, owner_json)
            VALUES (${ownerKey}, 'reservation-1', 'controller-1', 'outcome-unknown',
              ${hostedRecord(fixture.profile.target!.targetId)})`;
        const order: string[] = [];
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({ fixture, sql, order, ownerPath: path }),
        );
        // The owner's acknowledgement decides; the backend no longer blocks
        // locally on an uncertain but well-formed reservation.
        expect(outcome.kind).toBe("open");
        if (outcome.kind === "open") yield* outcome.owner.shutdown?.() ?? Effect.void;
      }),
    );
  });

  it("keeps admission closed when the pane acknowledgement is partial", async () => {
    const { fixture, path } = await prepare("reconcile-partial");
    await withPersistence(fixture, (sql) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => markBuildADrained(sql, fixture.stateDirectory));
        yield* Effect.promise(() =>
          seedPane(fixture, sql, hostedRecord(fixture.profile.target!.targetId)),
        );
        const order: string[] = [];
        const outcome = yield* runSshOwnerBootSequence(
          bootInput({ fixture, sql, order, ownerPath: path }),
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
});
