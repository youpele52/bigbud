import { CommandId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
  captureLifecycleTest,
  captureThreadId,
} from "./ThreadMetadataGeneration.capture.test-helpers.ts";

const operations = ["title", "summary"] as const;

describe("durable metadata capture lifecycle", () => {
  it.each(
    operations.flatMap((operation) =>
      (["branch-before-step", "branch-after-stale", "source-rewrite"] as const).map((change) => ({
        operation,
        change,
      })),
    ),
  )("recaptures $operation after $change without resetting deadlines", ({ operation, change }) =>
    captureLifecycleTest(operation, (f) =>
      Effect.gen(function* () {
        yield* f.request();
        const original = yield* f.open;
        const captured = f.control.captures;
        yield* f.request();
        expect(f.control.captures).toBe(captured);
        if (change === "source-rewrite")
          yield* f.engine.dispatch({
            type: "thread.message.assistant.replace",
            commandId: CommandId.makeUnsafe("rewrite-source"),
            threadId: captureThreadId,
            messageId: MessageId.makeUnsafe("assistant-0"),
            text: "Corrected source, same first user ID and frontier",
            createdAt: f.now(),
          });
        else yield* f.branch("generated-first-turn-name");
        f.control.time += 5_000;
        if (change === "branch-after-stale") {
          yield* f.service.step(original.jobId);
          expect((yield* f.read(original.jobId)).state).toBe("stale");
        }
        // A new factory instance reconstructs capture identity from SQL, not a local map.
        const resumed = yield* f.compose();
        yield* operation === "title"
          ? resumed.title({
              threadId: captureThreadId,
              messageText: "Repair durable capture lifecycle",
            })
          : resumed.summary({ threadId: captureThreadId, force: true });
        const replacement = yield* f.open;
        expect(replacement.jobId).not.toBe(original.jobId);
        expect(replacement.generationKey.startsWith(`${original.generationKey}:capture:`)).toBe(
          true,
        );
        expect(replacement.deadlineAt).toBe(original.deadlineAt);
        expect(replacement.modelWaitUntil).toBe(original.modelWaitUntil);
        expect(replacement.nativeWaitUntil).toBe(original.nativeWaitUntil);
        expect((yield* f.read(original.jobId)).state).toBe("stale");
        yield* f.request();
        expect((yield* f.open).jobId).toBe(replacement.jobId);
        yield* resumed.step(replacement.jobId);
        yield* resumed.step(replacement.jobId);
        expect((yield* f.read(replacement.jobId)).state).toBe("completed");
        const thread = (yield* f.engine.ensureThreadState!(captureThreadId, "history"))!;
        expect(operation === "title" ? thread.title : thread.elevatorSummary).toBe(
          "Repair durable capture lifecycle",
        );
        expect(f.control.calls).toEqual(["model-a"]);
        expect(yield* f.jobs).toHaveLength(2);
      }),
    ),
  );

  it.each(operations)(
    "admits %s retry under settings B before pending A is scheduled",
    (operation) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* f.request();
          const original = yield* f.open;
          const prepared = yield* f.prepare(original);
          yield* f.settings.updateSettings({
            textGenerationModelSelection: { provider: "codex", model: "model-b" },
          });
          yield* f.request("explicit-retry-b");
          const accepted = yield* f.open;
          expect(accepted.jobId).not.toBe(original.jobId);
          expect(accepted.configEpoch).not.toBe(original.configEpoch);
          expect((yield* f.read(original.jobId)).state).toBe("stale");
          expect((yield* f.repository.listAttempts(original.jobId))[0]?.state).toBe("stale");
          expect(yield* f.repository.claimDispatch(prepared, f.now())).toBe(false);
          const captures = f.control.captures;
          yield* f.request("explicit-retry-b");
          expect((yield* f.open).jobId).toBe(accepted.jobId);
          expect(f.control.captures).toBe(captures);
          yield* f.service.step(original.jobId);
          yield* f.service.step(accepted.jobId);
          yield* f.service.step(accepted.jobId);
          expect(f.control.calls).toEqual(["model-b"]);
          expect((yield* f.read(accepted.jobId)).state).toBe("completed");
          // Duplicate explicit request identity survives revision, epoch, and factory changes.
          yield* f.settings.updateSettings({
            textGenerationModelSelection: { provider: "codex", model: "model-c" },
          });
          const resumed = yield* f.compose();
          yield* operation === "title"
            ? resumed.title({
                threadId: captureThreadId,
                messageText: "Repair durable capture lifecycle",
                retryKey: "explicit-retry-b",
              })
            : resumed.summary({
                threadId: captureThreadId,
                force: true,
                retryKey: "explicit-retry-b",
              });
          expect(yield* f.jobs).toHaveLength(2);
          expect(f.control.calls).toEqual(["model-b"]);
        }),
      ),
  );

  it.each(operations)(
    "defers a distinct %s retry rather than silently coalescing its identity",
    (operation) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* f.request();
          const original = yield* f.open;
          const captured = f.control.captures;
          expect((yield* f.request("different-request").pipe(Effect.flip))._tag).toBe(
            "MetadataCoordinatorError",
          );
          expect((yield* f.open).jobId).toBe(original.jobId);
          expect(f.control.captures).toBe(captured);
          expect(yield* f.jobs).toHaveLength(1);
        }),
      ),
  );

  it.each(operations)(
    "does not replenish a paid stale %s capture after repeated workspace changes",
    (operation) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* f.request();
          const original = yield* f.open;
          yield* f.branch("first-name");
          yield* f.request();
          const replacement = yield* f.open;
          f.control.outcome = "failed";
          yield* f.service.step(replacement.jobId);
          expect(f.control.calls).toEqual(["model-a"]);
          yield* f.branch("second-name");
          yield* f.service.step(replacement.jobId);
          expect((yield* f.read(replacement.jobId)).state).toBe("stale");
          for (let index = 0; index < 3; index++) {
            yield* f.branch(`later-name-${index}`);
            yield* f.request();
          }
          expect(yield* f.jobs).toHaveLength(2);
          expect((yield* f.repository.listAttempts(replacement.jobId)).map((a) => a.state)).toEqual(
            ["failed"],
          );
          expect(f.control.calls).toEqual(["model-a"]);
          expect((yield* f.read(original.jobId)).state).toBe("stale");
        }),
      ),
  );

  it.each(
    operations.flatMap((operation) =>
      (["dispatch-intent", "acknowledged", "uncertain", "result-ready"] as const).map((state) => ({
        operation,
        state,
      })),
    ),
  )(
    "preserves $operation $state reservations during incompatible retry admission",
    ({ operation, state }) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* f.request();
          const original = yield* f.open;
          const prepared = yield* f.prepare(original);
          expect(yield* f.repository.claimDispatch(prepared, f.now())).toBe(true);
          if (state !== "dispatch-intent") {
            const attempt = (yield* f.repository.listAttempts(original.jobId))[0]!;
            expect(
              yield* f.repository.settleAttempt({
                attempt,
                state,
                at: f.now(),
                ...(state === "result-ready" ? { result: "Retained output" } : {}),
              }),
            ).toBe(true);
          }
          yield* f.settings.updateSettings({
            textGenerationModelSelection: { provider: "codex", model: "model-b" },
          });
          yield* f.branch("changed-after-dispatch");
          expect((yield* f.request("blocked-retry").pipe(Effect.flip))._tag).toBe(
            "MetadataCoordinatorError",
          );
          expect((yield* f.open).jobId).toBe(original.jobId);
          expect((yield* f.repository.listAttempts(original.jobId))[0]?.state).toBe(state);
          expect(yield* f.jobs).toHaveLength(1);
          expect(f.control.calls).toEqual([]);
        }),
      ),
  );
  it.each(operations)(
    "recaptures an undispatched %s retry without changing its request identity",
    (operation) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          yield* f.request("stable-retry");
          const original = yield* f.open;
          yield* f.settings.updateSettings({
            textGenerationModelSelection: { provider: "codex", model: "model-b" },
          });
          yield* f.request("stable-retry");
          const replacement = yield* f.open;
          expect(replacement.generationKey.startsWith(`${original.generationKey}:capture:`)).toBe(
            true,
          );
          expect(replacement.deadlineAt).toBe(original.deadlineAt);
          yield* f.request("stable-retry");
          expect((yield* f.open).jobId).toBe(replacement.jobId);
          yield* f.service.step(replacement.jobId);
          yield* f.service.step(replacement.jobId);
          expect(f.control.calls).toEqual(["model-b"]);
          expect(yield* f.jobs).toHaveLength(2);
        }),
      ),
  );

  it.each(operations)("does not extend an expired %s capture by changing workspace", (operation) =>
    captureLifecycleTest(operation, (f) =>
      Effect.gen(function* () {
        yield* f.request();
        const original = yield* f.open;
        f.control.time = Date.parse(original.deadlineAt) + 1;
        yield* f.branch("changed-after-deadline");
        yield* f.request();
        expect((yield* f.read(original.jobId)).state).toBe("stale");
        expect(yield* f.jobs).toHaveLength(1);
        expect(f.control.calls).toEqual([]);
      }),
    ),
  );
});
