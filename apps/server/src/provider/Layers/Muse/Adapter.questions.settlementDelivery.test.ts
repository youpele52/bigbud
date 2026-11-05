import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderTurnLivenessRepositoryLive } from "../../../persistence/Layers/ProviderTurnLiveness.ts";
import { ProviderTurnLivenessRepository } from "../../../persistence/Services/ProviderTurnLiveness.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "../../../orchestration/Layers/ProviderRuntimeIngestion.test.helpers.ts";
import { connectMuseCanonicalHarness } from "./Adapter.canonical.test.helpers.ts";
import { deferred, makeMuseTestHost, startInput } from "./Adapter.failures.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const questions = [
  {
    id: "single",
    header: "One",
    question: "Choose one?",
    selection: { mode: "single" },
    options: [{ label: "submitted" }, { label: "native" }],
  },
  {
    id: "multiple",
    header: "Several",
    question: "Choose several?",
    selection: { mode: "multiple" },
    options: [{ label: "left" }, { label: "right" }],
  },
  {
    id: "text",
    header: "Other",
    question: "Your answer?",
    selection: { mode: "single" },
    options: [{ label: "one" }, { label: "two" }],
  },
];
const recorded = [
  { questionId: "single", selectedLabel: "native" },
  { questionId: "multiple", selectedLabels: ["left", "right"] },
  { questionId: "text", freeText: "actual recorded free text" },
];
const expected = {
  single: "native",
  multiple: ["left", "right"],
  text: "actual recorded free text",
};

describe("Muse recorded user-input settlement before command acknowledgement", () => {
  registerProviderRuntimeIngestionTestCleanup();

  it.each(["accepted", "lost", "malformed"])(
    "persists the actual recorded answer map exactly once before an %s ack",
    async (acknowledgement) => {
      const harness = await createHarness({ provider: "muse" });
      const host = makeMuseTestHost();
      const ackGate = deferred<void>();
      const original = host.transport.command;
      host.transport.command = async (method, params, cid) => {
        if (method === "userInput/answer") {
          host.emit({
            method: "userInput/settled",
            params: {
              sessionId: host.sessionId(),
              userInputId: "prompt",
              outcome: "answered",
              answers: recorded,
              decidedByCommandId: cid,
            },
          });
          await ackGate.promise;
          if (acknowledgement === "lost") throw new Error("lost answer acknowledgement");
          if (acknowledgement === "malformed") return {};
        }
        return original(method, params, cid);
      };
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const seeded = (yield* harness.engine.getReadModel()).threads[0]!;
            yield* harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.makeUnsafe("set-epoch"),
              threadId,
              session: { ...seeded.session!, sessionEpoch: 1 },
              advanceSessionEpoch: true,
              createdAt: new Date().toISOString(),
            });
            const liveness = yield* ProviderTurnLivenessRepository;
            const adapter = yield* host.adapter();
            const delivery = yield* connectMuseCanonicalHarness(harness, adapter, liveness);
            yield* adapter.startSession({ ...startInput, threadId, sessionEpoch: 1 });
            yield* Effect.promise(() =>
              host.request({
                method: "userInput/request",
                params: { sessionId: host.sessionId(), userInputId: "prompt", questions },
              }),
            );
            const response = yield* adapter
              .respondToUserInput(threadId, "prompt" as never, {
                single: "submitted",
                multiple: ["left"],
                text: "submitted text",
              })
              .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
            const event = yield* delivery.waitForEvent(
              (candidate) => candidate.type === "user-input.resolved",
            );
            expect(event).toMatchObject({
              requestId: "prompt",
              sessionEpoch: 1,
              payload: { answers: expected },
            });
            yield* Effect.promise(() => harness.drain());
            const canonical = yield* Effect.promise(() =>
              waitForThread(harness.engine, (thread) =>
                thread.activities.some((activity) => activity.kind === "user-input.resolved"),
              ),
            );
            expect(
              canonical.activities.find((activity) => activity.kind === "user-input.resolved")
                ?.payload,
            ).toMatchObject({ requestId: "prompt", answers: expected });
            const persisted = yield* Effect.promise(() => harness.getPersistedSnapshot());
            expect(
              persisted.threads
                .find((thread) => thread.id === threadId)
                ?.activities.find((activity) => activity.kind === "user-input.resolved")?.payload,
            ).toMatchObject({ answers: expected });
            ackGate.resolve();
            const result = yield* Fiber.join(response);
            expect(result._tag).toBe(acknowledgement === "accepted" ? "Success" : "Failure");
            if (result._tag === "Failure")
              expect(result.failure.failureClass).toBe("unsafe-to-replay");
            host.emit({
              method: "userInput/settled",
              params: {
                sessionId: host.sessionId(),
                userInputId: "prompt",
                outcome: "answered",
                answers: recorded,
              },
            });
            yield* adapter.stopAll();
            yield* delivery.waitForEvent((candidate) => candidate.type === "session.exited");
            yield* Effect.promise(() => harness.drain());
            expect(
              delivery.events.filter((candidate) => candidate.type === "user-input.resolved"),
            ).toHaveLength(1);
            expect(
              (yield* harness.engine.getReadModel()).threads[0]?.activities.filter(
                (activity) => activity.kind === "user-input.resolved",
              ),
            ).toHaveLength(1);
          }),
        ).pipe(
          Effect.provide(
            ProviderTurnLivenessRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          ),
        ),
      );
    },
  );
});
