import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ServerSettings,
} from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  DAY,
  MINUTE,
  terminalCandidate,
  terminalSweepFixture,
} from "./ThreadOrganizationReactor.terminalIdle.fixture.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";
import type { TerminalIdleWork, TerminalManagerShape } from "../../terminal/Services/Manager.ts";

const idleOnly: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, inyosiraOlderThreadsEnabled: false };
const olderOnly: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, inyosiraIdleCleanupEnabled: false };

for (const rule of ["idle", "older"] as const) {
  const timeout = rule === "idle" ? 10 * MINUTE : DAY;
  const settings = rule === "idle" ? idleOnly : olderOnly;
  const state = rule === "idle" ? "present" : "later";
  it.effect(`${rule}: busy/unknown panes veto; ordinary shells remain eligible`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* terminalSweepFixture({
          settings,
          candidates: [
            terminalCandidate("busy", state),
            terminalCandidate("unknown", state),
            terminalCandidate("shell", state),
          ],
        });
        yield* fixture.establishEligibility(timeout);
        fixture.work.set("busy", { state: "busy", quietSince: null });
        fixture.work.set("unknown", { state: "unknown", quietSince: null });
        fixture.work.set("shell", { state: "idle", quietSince: null });
        yield* fixture.advance(rule === "idle" ? timeout + MINUTE : MINUTE);
        assert.deepEqual(
          fixture.commands.map((command) => ("threadId" in command ? command.threadId : null)),
          [terminalCandidate("shell").threadId],
        );
        assert.equal(fixture.commands[0]?.type, "thread.organization.idle");
        yield* fixture.advance(MINUTE);
        assert.equal(fixture.commands.length, 1);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    `${rule}: work completion receives the full configured window and moves at equality`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* terminalSweepFixture({
            settings,
            candidates: [terminalCandidate("finishing", state)],
          });
          yield* fixture.establishEligibility(timeout);
          fixture.work.set("finishing", { state: "busy", quietSince: null });
          // End at an attempted-candidate minute boundary, so retry timing does not hide cutoff equality.
          yield* fixture.advance(rule === "idle" ? timeout + 15_000 : 15_000);
          assert.equal(fixture.commands.length, 0);
          const finishedAt = yield* fixture.now;
          fixture.work.set("finishing", { state: "idle", quietSince: finishedAt });
          yield* fixture.advance(timeout - 15_000);
          assert.equal(fixture.commands.length, 0);
          yield* fixture.advance(15_000);
          assert.equal(fixture.commands.length, 1);
          const command = fixture.commands[0]!;
          assert.equal(command.type, "thread.organization.idle");
          if (command.type === "thread.organization.idle") {
            assert.equal(command.fromState, state);
            assert.equal(command.terminalIdleCutoff, new Date(finishedAt).toISOString());
            assert.equal(Date.parse(command.createdAt) - finishedAt, timeout);
          }
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );
}

it.effect("an older-rule quiet-window veto cannot starve an eligible short-rule move", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* terminalSweepFixture({
        settings: DEFAULT_SERVER_SETTINGS,
        candidates: [terminalCandidate("short-ready")],
      });
      yield* fixture.establishEligibility(DAY);
      fixture.work.set("short-ready", {
        state: "idle",
        quietSince: (yield* fixture.now) - 20 * MINUTE,
      });
      yield* fixture.advance(15_000);
      assert.equal(fixture.commands.length, 1);
      const command = fixture.commands[0]!;
      assert.equal(command.type, "thread.organization.idle");
      if (command.type === "thread.organization.idle") assert.equal(command.destination, "later");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("an accepted older-rule dispatch still suppresses duplicate same-revision moves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* terminalSweepFixture({
        settings: DEFAULT_SERVER_SETTINGS,
        candidates: [terminalCandidate("both-ready")],
        dispatch: () => Effect.succeed({ sequence: 1 }),
      });
      yield* fixture.establishEligibility(DAY);
      yield* fixture.advance(15_000);
      assert.equal(fixture.commands.length, 1);
      const command = fixture.commands[0]!;
      if (command.type === "thread.organization.idle") assert.equal(command.destination, "done");
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "bounded sweep reaches eligible rows behind 260 busy/unknown rows and resets paging on policy change",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const candidates = Array.from({ length: 261 }, (_, index) =>
          terminalCandidate(`thread-${String(index).padStart(3, "0")}`, "later"),
        );
        const fixture = yield* terminalSweepFixture({ settings: olderOnly, candidates });
        yield* fixture.establishEligibility(DAY);
        for (let index = 0; index < 260; index++)
          fixture.work.set(candidates[index]!.threadId, {
            state: index % 2 ? "unknown" : "busy",
            quietSince: null,
          });
        yield* fixture.advance(6 * 15_000);
        assert.equal(fixture.commands.length, 1);
        const command = fixture.commands[0]!;
        assert.equal("threadId" in command ? command.threadId : null, "thread-260");
        assert.equal(fixture.queries.length, 6);
        assert.isAtMost(fixture.workReads, 6 * 50);
        assert.isTrue(fixture.queries.every((query) => query.limit === 50));
        assert.isDefined(fixture.queries[1]?.after);
        // Move into another page, then change policy. The next post-grace query must restart at root.
        yield* fixture.advance(15_000);
        const beforeChange = fixture.queries.length;
        yield* fixture.change({ ...olderOnly, inyosiraOlderThreadsDays: 2 });
        yield* fixture.advance(2 * DAY - 15_000);
        assert.equal(fixture.queries.length, beforeChange);
        yield* fixture.advance(15_000);
        assert.isUndefined(fixture.queries.at(-1)?.after);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
);

it("a candidate that becomes busy after sweep selection is vetoed by the real serialized engine", () =>
  withDatabase("terminal-sweep-final-guard-", async (dbPath) => {
    const candidate = terminalCandidate("queued-terminal-race");
    const work = new Map<string, TerminalIdleWork>();
    const unused = () => Effect.die("unused terminal operation");
    const terminal: TerminalManagerShape = {
      getThreadIdleWork: (threadId) =>
        Effect.sync(() => work.get(threadId) ?? { state: "idle", quietSince: null }),
      open: unused,
      snapshot: unused,
      restart: unused,
      write: () => Effect.void,
      resize: () => Effect.void,
      clear: () => Effect.void,
      close: () => Effect.void,
      subscribe: () => Effect.succeed(() => {}),
    };
    const runtime = createRuntime(dbPath, terminal);
    try {
      const engine = await engineFor(runtime);
      for (const command of createCommands(ProjectId.makeUnsafe("terminal-sweep-race"), [
        candidate.threadId,
      ])) {
        await runtime.runPromise(engine.dispatch(command));
      }
      const sequence = (await runtime.runPromise(engine.getReadModel())).snapshotSequence;
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* terminalSweepFixture({
              settings: idleOnly,
              candidates: [candidate],
              work,
              dispatch: (command) =>
                Effect.sync(() => {
                  work.set(candidate.threadId, { state: "busy", quietSince: null });
                }).pipe(Effect.andThen(engine.dispatch(command))),
            });
            yield* fixture.advance(10 * MINUTE);
            assert.equal(fixture.commands.length, 1);
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
      const readModel = await runtime.runPromise(engine.getReadModel());
      assert.equal(readModel.snapshotSequence, sequence);
      assert.equal(
        readModel.threads.find((thread) => thread.id === candidate.threadId)?.organization?.state,
        "present",
      );
      // Manual organization remains authoritative while the same terminal is still busy.
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.organization.move",
          commandId: CommandId.makeUnsafe("manual-after-sweep-veto"),
          threadId: candidate.threadId,
          state: "later",
          createdAt: new Date().toISOString(),
        }),
      );
      assert.equal(
        (await runtime.runPromise(engine.getReadModel())).threads.find(
          (thread) => thread.id === candidate.threadId,
        )?.organization?.state,
        "later",
      );
    } finally {
      await runtime.dispose();
    }
  }));
