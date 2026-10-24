import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Exit } from "effect";

import {
  ProviderTurnAdmissions,
  ProviderTurnAdmissionConflict,
} from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { admitV2Turn, V2AdmissionUnconfirmed, type V2AdmissionRequest } from "./Admission.ts";
import {
  admissionCorrelation,
  learningAdmissionIdentity,
  isDurableLearningThread,
} from "./Admission.identity.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const request = (id: string): V2AdmissionRequest => ({
  identity: {
    namespace: "foreground",
    ownerThreadId: ThreadId.makeUnsafe("thread"),
    requestMessageId: MessageId.makeUnsafe(id),
  },
  binding: {
    provider: "opencodeV2",
    threadId: ThreadId.makeUnsafe("thread"),
    nativeSessionId: "ses_test",
    location: "/fixture",
    runtimeTargetId: "local",
    workspaceTargetId: "local",
    storageIdentity: "fixture",
  },
  fingerprint: "same-prompt-material",
  isCurrent: () => true,
  dispatch: () => Effect.succeed(true),
  reconcile: () => Effect.succeed("unknown"),
});

it.layer(layer)("OpenCode v2 admission write-before-dispatch", (it) => {
  it.effect("preparation failure retains only a reservation and exact retry dispatches once", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      let prepares = 0,
        sends = 0;
      const input: V2AdmissionRequest = {
        ...request("prepare-retry"),
        prepare: (row) =>
          Effect.gen(function* () {
            assert.strictEqual(row.state, "reserved");
            prepares++;
            if (prepares === 1)
              return yield* new V2AdmissionUnconfirmed({ detail: "preparation failed" });
          }),
        dispatch: () => Effect.sync(() => (++sends, true)),
      };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(admitV2Turn(input))));
      assert.strictEqual((yield* journal.find(input.identity))?.state, "reserved");
      assert.strictEqual(sends, 0);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(admitV2Turn({ ...input, fingerprint: "changed material" })),
        ),
      );
      assert.strictEqual(prepares, 1);
      assert.strictEqual((yield* admitV2Turn(input)).state, "accepted");
      yield* admitV2Turn(input);
      assert.strictEqual(prepares, 2);
      assert.strictEqual(sends, 1);
    }),
  );
  it.effect("ownership loss during preparation never promotes the reservation to intent", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      let current = true;
      const input: V2AdmissionRequest = {
        ...request("prepare-owner-loss"),
        isCurrent: () => current,
        prepare: () =>
          Effect.sync(() => {
            current = false;
          }),
        dispatch: () => Effect.die("must not dispatch"),
      };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(admitV2Turn(input))));
      assert.strictEqual((yield* journal.find(input.identity))?.state, "reserved");
    }),
  );
  it.effect(
    "rejects a stale caller before reserve but retains a reserve physically issued before loss",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const previous = yield* admitV2Turn(request("preserved-prior"));
        let current = false,
          reserves = 0,
          sends = 0;
        const input = {
          ...request("pre-reserve-cancel"),
          isCurrent: () => current,
          dispatch: () =>
            Effect.sync(() => {
              sends++;
              return true;
            }),
        };
        const observed = {
          ...journal,
          reserve: (value: Parameters<typeof journal.reserve>[0]) => {
            reserves++;
            return journal.reserve(value).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  current = false;
                }),
              ),
            );
          },
        };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              admitV2Turn(input).pipe(Effect.provideService(ProviderTurnAdmissions, observed)),
            ),
          ),
        );
        assert.strictEqual(reserves, 0);
        assert.strictEqual(sends, 0);
        assert.isUndefined(yield* journal.find(input.identity));
        current = true;
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              admitV2Turn(input).pipe(Effect.provideService(ProviderTurnAdmissions, observed)),
            ),
          ),
        );
        assert.strictEqual(reserves, 1);
        assert.strictEqual(sends, 0);
        assert.strictEqual((yield* journal.find(input.identity))?.state, "reserved");
        assert.deepEqual(yield* journal.find(previous), previous);
      }),
  );
  it.effect(
    "failed durable intent writes prevent RPC, while failed accepted writes retain uncertainty",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        let sends = 0;
        const input = {
          ...request("write-failure"),
          dispatch: () =>
            Effect.sync(() => {
              sends++;
              return true;
            }),
        };
        const failing = {
          ...journal,
          transition: () =>
            Effect.fail(new ProviderTurnAdmissionConflict({ detail: "synthetic write failure" })),
        };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              admitV2Turn(input).pipe(Effect.provideService(ProviderTurnAdmissions, failing)),
            ),
          ),
        );
        assert.strictEqual(sends, 0);
        const failedAcceptance = {
          ...journal,
          transition: (
            current: Parameters<typeof journal.transition>[0],
            state: Parameters<typeof journal.transition>[1],
            time: string,
          ) =>
            state === "accepted"
              ? Effect.fail(
                  new ProviderTurnAdmissionConflict({ detail: "synthetic accepted write failure" }),
                )
              : journal.transition(current, state, time),
        };
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              admitV2Turn(input).pipe(
                Effect.provideService(ProviderTurnAdmissions, failedAcceptance),
              ),
            ),
          ),
        );
        assert.strictEqual(sends, 1);
        assert.strictEqual((yield* journal.find(input.identity))?.state, "dispatch-intent");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(admitV2Turn(input))));
        assert.strictEqual(sends, 1);
      }),
  );
  it.effect("persists intent before RPC and never redispatches accepted requests", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      let sends = 0;
      const input = {
        ...request("accepted"),
        dispatch: (row: Parameters<V2AdmissionRequest["dispatch"]>[0]) =>
          Effect.gen(function* () {
            assert.strictEqual(
              (yield* journal.find(row).pipe(Effect.orDie))?.state,
              "dispatch-intent",
            );
            sends++;
            return true;
          }),
      };
      const accepted = yield* admitV2Turn(input);
      const repaired = yield* admitV2Turn(input);
      assert.strictEqual(sends, 1);
      assert.deepEqual(repaired, accepted);
    }),
  );

  it.effect("lost ack, restart retry, and idle/missing observations never license resend", () =>
    Effect.gen(function* () {
      const journal = yield* ProviderTurnAdmissions;
      let sends = 0;
      const input = {
        ...request("lost-ack"),
        dispatch: () => {
          sends++;
          return Effect.fail(new V2AdmissionUnconfirmed({ detail: "simulated ack lost" }));
        },
      };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(admitV2Turn(input))));
      assert.strictEqual((yield* journal.find(input.identity))?.state, "dispatch-intent");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(admitV2Turn(input))));
      assert.strictEqual(sends, 1);
      const repaired = yield* admitV2Turn({
        ...input,
        reconcile: () => Effect.succeed("accepted"),
      });
      assert.strictEqual(repaired.state, "accepted");
      assert.strictEqual(sends, 1);
    }),
  );

  it.effect(
    "distinct identical submissions remain distinct and stale responses cannot accept",
    () =>
      Effect.gen(function* () {
        const first = yield* admitV2Turn(request("identical-one"));
        const second = yield* admitV2Turn(request("identical-two"));
        assert.notStrictEqual(first.nativeAdmissionId, second.nativeAdmissionId);
        let current = true;
        const input = {
          ...request("stale"),
          isCurrent: () => current,
          dispatch: () =>
            Effect.sync(() => {
              current = false;
              return true;
            }),
        };
        assert.isTrue(Exit.isFailure(yield* Effect.exit(admitV2Turn(input))));
        const journal = yield* ProviderTurnAdmissions;
        assert.strictEqual((yield* journal.find(input.identity))?.state, "dispatch-intent");
      }),
  );

  it.effect("concurrent same-request calls dispatch at most once", () =>
    Effect.gen(function* () {
      let sends = 0;
      const input = {
        ...request("race"),
        dispatch: () =>
          Effect.sync(() => {
            sends++;
            return true;
          }),
      };
      const results = yield* Effect.all(
        [Effect.exit(admitV2Turn(input)), Effect.exit(admitV2Turn(input))],
        { concurrency: 2 },
      );
      assert.strictEqual(sends, 1);
      assert.isTrue(results.some(Exit.isSuccess));
    }),
  );

  it.effect(
    "durable job identity is isolated and survives retries without foreground ownership",
    () =>
      Effect.gen(function* () {
        const owner = ThreadId.makeUnsafe("job-owner");
        const first = learningAdmissionIdentity(owner, "job-1");
        assert.deepEqual(first, learningAdmissionIdentity(owner, "job-1"));
        assert.notDeepEqual(first, learningAdmissionIdentity(owner, "job-2"));
        assert.isTrue(isDurableLearningThread(first.threadId));
        assert.isFalse(isDurableLearningThread(owner));
        const input = {
          ...request("unused"),
          identity: first.identity,
          binding: { ...request("unused").binding, threadId: first.threadId },
        };
        const admitted = yield* admitV2Turn(input);
        assert.notStrictEqual(admitted.binding.threadId, owner);
        assert.deepEqual(admissionCorrelation(first.identity), {
          nativeAdmissionId: admitted.nativeAdmissionId,
          turnId: admitted.turnId,
        });
      }),
  );
});
