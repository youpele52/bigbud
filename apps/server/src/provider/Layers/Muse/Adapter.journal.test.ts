import { MessageId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProviderTurnAdmissionConflict,
  ProviderTurnAdmissions,
} from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { advanceMuseJournal, settleMuseJournalTerminal } from "./Adapter.journal.ts";
import { executeMuseRecovery, scanMuseJournal } from "./Adapter.recovery.ts";
import {
  deferred,
  makeMuseTestHost,
  makeMuseTestState,
  startInput,
  threadId,
} from "./Adapter.failures.test.helpers.ts";
import { makeMuseHostCallbacks } from "./Adapter.startSession.callbacks.ts";
import { getMuseFailureEvidence } from "./Client.errors.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const outage = new PersistenceSqlError({ operation: "transition", detail: "disk unavailable" });

describe("Muse monotonic durable journal (real SQLite)", () => {
  it.each(["changed-material", "no-progress"])(
    "fails safely and bounds CAS reconciliation for %s",
    async (mode) => {
      const host = makeMuseTestHost();
      const original = host.transport.command;
      host.transport.command = async (method, params, cid) => {
        if (method === "turn/start") throw new Error("lost ack");
        return original(method, params, cid);
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* ProviderTurnAdmissions;
          const adapter = yield* host.adapter({ admissions: journal });
          yield* adapter.startSession(startInput);
          yield* adapter
            .sendTurn({
              threadId,
              input: "work",
              requestMessageId: MessageId.makeUnsafe("request"),
            })
            .pipe(Effect.result);
          const row = (yield* journal.listBound(threadId, 100))[0]!;
          let attempts = 0;
          const conflict = new ProviderTurnAdmissionConflict({ detail: "changed concurrently" });
          const result = yield* advanceMuseJournal(
            {
              ...journal,
              transition: () => {
                attempts++;
                return Effect.fail(conflict);
              },
              find: () =>
                Effect.succeed(
                  mode === "changed-material" ? { ...row, fingerprint: "different" } : row,
                ),
            },
            row,
            "accepted",
          ).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(attempts).toBe(mode === "changed-material" ? 1 : 6);
          if (result._tag === "Failure")
            expect(result.failure.failureClass).toBe("unsafe-to-replay");
          expect((yield* journal.listBound(threadId, 100))[0]).toEqual(row);
          yield* adapter.stopAll();
        }).pipe(Effect.provide(layer)),
      );
    },
  );
  it("terminal-before-ack accepts concurrent progress without reopening a terminal row", async () => {
    const host = makeMuseTestHost();
    const terminalPersisted = deferred<void>();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      if (method === "turn/start") {
        host.emit({ method: "turn/started", params: { turnId: cid } });
        host.emit({ method: "turn/completed", params: { turnId: cid, terminal: "failed" } });
        await terminalPersisted.promise;
      }
      return original(method, params, cid);
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const admissions = {
          ...journal,
          transition: (...args: Parameters<typeof journal.transition>) =>
            journal.transition(...args).pipe(
              Effect.tap((row) =>
                Effect.sync(() => {
                  if (row.state === "terminal") terminalPersisted.resolve();
                }),
              ),
            ),
        };
        const adapter = yield* host.adapter({ admissions });
        yield* adapter.startSession(startInput);
        const ack = yield* adapter.sendTurn({
          threadId,
          input: "work",
          requestMessageId: MessageId.makeUnsafe("request"),
        });
        const rows = yield* journal.listBound(threadId, 100);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          state: "terminal",
          terminalOutcome: "failed",
          revision: 3,
          turnId: ack.turnId,
        });
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBeUndefined();
        const row = rows[0]!;
        const stale = {
          ...row,
          state: "dispatch-intent" as const,
          revision: 1,
          terminalOutcome: undefined,
        };
        const accepted = yield* advanceMuseJournal(journal, stale, "accepted");
        expect(accepted).toEqual(row);
        const settled = yield* settleMuseJournalTerminal(journal, stale, "completed");
        expect(settled).toEqual(row);
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does not report or publish recovered durable success after a failed journal write", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      if (method === "turn/start") throw new Error("lost ack");
      return original(method, params, cid);
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const adapter = yield* host.adapter({ admissions: journal });
        yield* adapter.startSession(startInput);
        yield* Effect.result(
          adapter.sendTurn({
            threadId,
            input: "work",
            requestMessageId: MessageId.makeUnsafe("request"),
          }),
        );
        const scan = yield* scanMuseJournal(journal, threadId);
        const published: Array<unknown> = [];
        const result = yield* executeMuseRecovery({
          admissions: { ...journal, transition: () => Effect.fail(outage) },
          threadId,
          scan,
          evidence: { lastTurn: { turnId: scan.rows[0]!.turnId, terminal: "completed" } },
          publish: (event) =>
            Effect.sync(() => {
              published.push(event);
            }),
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(getMuseFailureEvidence(result.failure)).toBe(outage);
          expect(result.failure.cause).toBeUndefined();
        }
        expect(published).toEqual([]);
        expect((yield* journal.listBound(threadId, 100))[0]?.state).toBe("dispatch-intent");
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("retains live settlement tracking and emits a bounded diagnostic when persistence fails", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      if (method === "turn/start") throw new Error("lost ack");
      return original(method, params, cid);
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const adapter = yield* host.adapter({ admissions: journal });
        yield* adapter.startSession(startInput);
        yield* Effect.result(
          adapter.sendTurn({
            threadId,
            input: "work",
            requestMessageId: MessageId.makeUnsafe("request"),
          }),
        );
        const row = (yield* journal.listBound(threadId, 100))[0]!;
        const state = makeMuseTestState(host);
        state.journalTurns.set(row.turnId, row);
        const observed = deferred<void>();
        const types: Array<string> = [];
        const callbacks = makeMuseHostCallbacks({
          threadId,
          getState: () => state,
          admissions: { ...journal, transition: () => Effect.fail(outage) },
          emit: (event) => {
            types.push(event.type);
            if (event.type === "runtime.error") observed.resolve();
          },
        });
        yield* Effect.promise(() => callbacks.activate());
        callbacks.onNotification({
          method: "turn/completed",
          params: { turnId: row.turnId, terminal: "completed" },
        });
        yield* Effect.promise(() => observed.promise);
        expect(types).toContain("turn.completed");
        expect(types).toContain("runtime.error");
        expect(state.journalTurns.get(row.turnId)).toBe(row);
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer)),
    );
  });

  it("does not swallow a failed proven-refusal settlement", async () => {
    const host = makeMuseTestHost();
    const original = host.transport.command;
    host.transport.command = async (method, params, cid) => {
      if (method === "turn/start") throw { kind: "commandRejected" };
      return original(method, params, cid);
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const adapter = yield* host.adapter({
          admissions: { ...journal, settleProvenRefusal: () => Effect.fail(outage) },
        });
        yield* adapter.startSession(startInput);
        const result = yield* adapter
          .sendTurn({ threadId, input: "work", requestMessageId: MessageId.makeUnsafe("request") })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.failureClass).toBe("unsafe-to-replay");
          expect(getMuseFailureEvidence(result.failure)).toBe(outage);
          expect(result.failure.cause).toBeUndefined();
        }
        expect((yield* journal.listBound(threadId, 100))[0]?.state).toBe("dispatch-intent");
        yield* adapter.stopAll();
      }).pipe(Effect.provide(layer)),
    );
  });
});
