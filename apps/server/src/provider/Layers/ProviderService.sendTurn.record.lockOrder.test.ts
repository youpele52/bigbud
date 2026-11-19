import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";

import { ProviderDispatchAttemptRepositoryLive } from "../../persistence/Layers/ProviderDispatchAttempts.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRecoveryIntentRepositoryLive } from "../../persistence/Layers/ThreadRecoveryIntents.ts";
import { ProviderDispatchAttemptRepository } from "../../persistence/Services/ProviderDispatchAttempts.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ThreadRecoveryIntentRepository } from "../../persistence/Services/ThreadRecoveryIntents.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { recordAcceptedSendTurn } from "./ProviderService.sendTurn.record.ts";

// D-1 (live arm64 re-run): under concurrent sessions the backend wedged with one SQL write
// transaction never committed. The provider acknowledgement transaction wrote the thread's
// binding through the directory, whose write lock a session start on another thread held while
// it waited for the one SQL connection. Lock order is now: directory write lock, then SQL.

/** Called whenever a binding is read; the session start's read happens under the write lock. */
let onBindingRead: (threadId: string) => Effect.Effect<void> = () => Effect.void;

const observedRuntimeRepository = Layer.effect(
  ProviderSessionRuntimeRepository,
  Effect.map(Effect.service(ProviderSessionRuntimeRepository), (live) => ({
    ...live,
    getByThreadId: (input: Parameters<typeof live.getByThreadId>[0]) =>
      Effect.suspend(() => onBindingRead(input.threadId)).pipe(
        Effect.andThen(live.getByThreadId(input)),
      ),
  })),
).pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive));

const layer = Layer.mergeAll(
  ProviderSessionDirectoryLive.pipe(Layer.provide(observedRuntimeRepository)),
  ThreadRecoveryIntentRepositoryLive,
  ProviderDispatchAttemptRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const at = "2026-11-19T08:00:00.000Z";
const messageId = MessageId.makeUnsafe("lock-order-message");

it.layer(layer)("recordAcceptedSendTurn lock order", (it) => {
  it.effect(
    "acknowledges a turn while another thread's session start writes its binding (D-1)",
    () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const intents = yield* ThreadRecoveryIntentRepository;
        const attempts = yield* ProviderDispatchAttemptRepository;
        const sendingThread = ThreadId.makeUnsafe("lock-order-sending");
        const startingThread = ThreadId.makeUnsafe("lock-order-starting");
        yield* intents.recordAccepted({
          threadId: sendingThread,
          messageId,
          provider: "codex",
          createdAt: at,
        });
        const attempt = Option.getOrThrow(
          yield* attempts.markMayHaveBeenSent({
            threadId: sendingThread,
            messageId,
            provider: "codex",
            payloadDigest: "lock-order",
            at,
          }),
        );

        const inTransaction = yield* Deferred.make<void>();
        const startHoldsWriteLock = yield* Deferred.make<void>();
        onBindingRead = (threadId) =>
          threadId === startingThread
            ? Deferred.succeed(startHoldsWriteLock, undefined)
            : Effect.void;

        // The session start on the other thread begins once the acknowledgement transaction is
        // open. Before the fix it took the free write lock and then waited for SQL.
        const sessionStart = yield* Deferred.await(inTransaction).pipe(
          Effect.andThen(directory.upsert({ threadId: startingThread, provider: "codex" })),
          Effect.forkChild,
        );
        yield* recordAcceptedSendTurn({
          adapter: { provider: "codex", listSessions: () => Effect.succeed([]) },
          directory,
          liveness: Option.none(),
          threadId: sendingThread,
          turnId: TurnId.makeUnsafe("lock-order-turn"),
          sessionEpoch: 1,
          acknowledge: (writes) =>
            attempts.acknowledgeWith(
              {
                attemptId: attempt.attemptId,
                threadId: sendingThread,
                messageId,
                turnId: TurnId.makeUnsafe("lock-order-turn"),
                provider: "codex",
                at,
              },
              // Inside the SQL transaction: let the session start run as far as it can (it
              // reaches its binding read only if the write lock is free), then write.
              Deferred.succeed(inTransaction, undefined).pipe(
                Effect.andThen(
                  Effect.raceFirst(Deferred.await(startHoldsWriteLock), Effect.sleep("300 millis")),
                ),
                Effect.andThen(writes),
              ),
            ),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () => Effect.die(new Error("acknowledgement deadlocked on the write lock")),
          }),
        );
        yield* Fiber.join(sessionStart).pipe(Effect.timeout("10 seconds"));
        onBindingRead = () => Effect.void;

        const acknowledged = Option.getOrThrow(
          yield* attempts.latestForIntent({ threadId: sendingThread, messageId }),
        );
        assert.strictEqual(acknowledged.state, "provider-acknowledged");
        const sending = Option.getOrThrow(yield* directory.getBinding(sendingThread));
        assert.strictEqual(sending.status, "running");
        assert.isTrue(Option.isSome(yield* directory.getBinding(startingThread)));
      }).pipe(TestClock.withLive),
  );
});
