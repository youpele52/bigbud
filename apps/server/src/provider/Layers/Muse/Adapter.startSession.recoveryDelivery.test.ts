import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { ProviderTurnLivenessRepositoryLive } from "../../../persistence/Layers/ProviderTurnLiveness.ts";
import { MuseSessionBindingsLive } from "../../../persistence/Layers/MuseSessionBindings.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnLivenessRepository } from "../../../persistence/Services/ProviderTurnLiveness.ts";
import { MuseSessionBindings } from "../../../persistence/Services/MuseSessionBindings.ts";
import { insertProjectionThreadParent } from "../../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { connectMuseCanonicalHarness } from "./Adapter.canonical.test.helpers.ts";
import {
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "../../../orchestration/Layers/ProviderRuntimeIngestion.test.helpers.ts";
import { deferred, makeMuseTestHost, startInput } from "./Adapter.failures.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("queued-turn");
const now = "2026-10-29T00:00:00.000Z";
const layer = Layer.mergeAll(
  ProviderTurnAdmissionsLive,
  MuseSessionBindingsLive,
  ProviderTurnLivenessRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("Muse simultaneous resume recovery and buffered lifecycle delivery", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it.each([false, true])(
    "keeps canonical state terminal/ready and delivers one terminal (prior liveness claim: %s)",
    async (alreadyClaimed) => {
      const harness = await createHarness({ provider: "muse" });
      const host = makeMuseTestHost();
      const readEntered = deferred<void>();
      const readReply = deferred<Record<string, unknown>>();
      const original = host.transport.request;
      host.transport.request = async (method, params) => {
        if (method !== "session/read") return original(method, params);
        readEntered.resolve();
        return readReply.promise;
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const admissions = yield* ProviderTurnAdmissions;
            const bindings = yield* MuseSessionBindings;
            const liveness = yield* ProviderTurnLivenessRepository;
            yield* insertProjectionThreadParent({ sql: yield* SqlClient.SqlClient, threadId });
            const reservedBinding = yield* bindings.reserve({
              threadId,
              nativeSessionId: "native",
              creationCommandId: "creation",
              workspace: process.cwd(),
              storageIdentity: "/fake-home",
              selectionFingerprint: "fp",
              createdAt: now,
            });
            yield* bindings.transition(reservedBinding, "bound");
            const reserved = yield* admissions.reserve({
              namespace: "foreground",
              ownerThreadId: threadId,
              requestMessageId: MessageId.makeUnsafe("queued-request"),
              nativeAdmissionId: turnId,
              turnId,
              fingerprint: "fp",
              createdAt: now,
              binding: {
                provider: "muse",
                threadId,
                nativeSessionId: "native",
                location: process.cwd(),
                storageIdentity: "/fake-home",
                runtimeTargetId: "local",
                workspaceTargetId: "local",
              },
            });
            const intent = yield* admissions.transition(reserved, "dispatch-intent", now);
            yield* admissions.transition(intent, "accepted", now);
            yield* liveness.startTurn({
              threadId,
              turnId,
              provider: "muse",
              sessionEpoch: 0,
              startedAt: now,
            });
            if (alreadyClaimed)
              yield* liveness.claimTerminal({
                threadId,
                turnId,
                provider: "muse",
                sessionEpoch: 0,
                terminalAt: now,
              });
            const adapter = yield* host.adapter({ admissions, bindings });
            const delivery = yield* connectMuseCanonicalHarness(harness, adapter, liveness);
            const startup = yield* adapter
              .startSession({ ...startInput, threadId })
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Effect.promise(() => readEntered.promise);
            host.emit({ method: "turn/started", params: { sessionId: "native", turnId } });
            host.emit({
              method: "item/completed",
              params: {
                sessionId: "native",
                item: {
                  itemId: "answer",
                  turnId,
                  kind: "agentMessage",
                  status: "completed",
                  text: "final recovered answer",
                },
              },
            });
            host.emit({
              method: "turn/completed",
              params: { sessionId: "native", turnId, terminal: "completed" },
            });
            readReply.resolve({
              session: {
                sessionId: "native",
                activeTurnId: null,
                modelId: startInput.modelSelection.model,
              },
              lastTurn: { turnId, terminal: "completed" },
              viewCursor: "done",
              history: {
                mode: "snapshot",
                snapshot: { viewCursor: "done", state: { activeTurn: null, queuedTurns: [] } },
              },
            });
            const session = yield* Fiber.join(startup);
            yield* delivery.waitForEvent(
              (event) => event.type === "turn.completed" && event.turnId === turnId,
            );
            // Late SDK duplicates must not reopen canonical state after liveness
            // has claimed the terminal and would suppress another ordinary terminal.
            host.emit({ method: "turn/started", params: { sessionId: "native", turnId } });
            host.emit({
              method: "turn/completed",
              params: { sessionId: "native", turnId, terminal: "completed" },
            });
            host.emit({
              method: "item/completed",
              params: {
                sessionId: "native",
                item: { itemId: "late-marker", turnId, kind: "toolCall", status: "completed" },
              },
            });
            yield* delivery.waitForEvent(
              (event) => event.type === "item.completed" && event.itemId === "late-marker",
            );
            yield* Effect.promise(() => harness.drain());
            const canonical = yield* Effect.promise(() =>
              waitForThread(
                harness.engine,
                (thread) =>
                  thread.session?.status === "ready" &&
                  thread.session.activeTurnId === null &&
                  thread.messages.some(
                    (message) => message.text === "final recovered answer" && !message.streaming,
                  ),
              ),
            );
            expect(canonical.session?.status).toBe("ready");
            expect(session.status).toBe("ready");
            expect(session.activeTurnId).toBeUndefined();
            expect(
              delivery.events
                .filter(
                  (event) =>
                    event.turnId === turnId &&
                    (event.type === "turn.started" || event.type === "turn.completed"),
                )
                .map((event) => event.type),
            ).toEqual(["turn.started", "turn.completed"]);
            expect(delivery.events.filter((event) => event.type === "turn.completed")).toHaveLength(
              1,
            );
            expect((yield* admissions.listBound(threadId, 100))[0]).toMatchObject({
              state: "terminal",
              terminalOutcome: "completed",
            });
            expect(yield* liveness.listActive()).toEqual([]);
            yield* adapter.stopAll();
          }),
        ).pipe(Effect.provide(layer)),
      );
    },
  );
});
