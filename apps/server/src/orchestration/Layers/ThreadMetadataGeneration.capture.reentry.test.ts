import { CommandId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  captureLifecycleTest,
  captureThreadId,
} from "./ThreadMetadataGeneration.capture.test-helpers.ts";

const operations = ["title", "summary"] as const;

describe("durable metadata capture reentry", () => {
  it.each(
    operations.flatMap((operation) =>
      (["workspace", "source"] as const).flatMap((change) =>
        [false, true].map((prepared) => ({ operation, change, prepared })),
      ),
    ),
  )(
    "reenters $operation A after $change A→B→A (prepared=$prepared)",
    ({ operation, change, prepared }) =>
      captureLifecycleTest(operation, (f) =>
        Effect.gen(function* () {
          const update = (value: "a" | "b", index: number) =>
            change === "workspace"
              ? f.engine.dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.makeUnsafe(`reentry-workspace-${index}`),
                  threadId: captureThreadId,
                  branch: `workspace-${value}`,
                })
              : f.engine.dispatch({
                  type: "thread.message.assistant.replace",
                  commandId: CommandId.makeUnsafe(`reentry-source-${index}`),
                  threadId: captureThreadId,
                  messageId: MessageId.makeUnsafe("assistant-0"),
                  text: `Source ${value}`,
                  createdAt: f.now(),
                });
          yield* update("a", 0);
          yield* f.request();
          const original = yield* f.open;
          const firstPrepared = prepared ? yield* f.prepare(original) : null;
          f.control.time += 5_000;
          yield* update("b", 1);
          yield* f.request();
          const middle = yield* f.open;
          const middlePrepared = prepared ? yield* f.prepare(middle) : null;
          expect(middle.jobId).not.toBe(original.jobId);
          expect((yield* f.read(original.jobId)).state).toBe("stale");
          f.control.time += 5_000;
          yield* update("a", 2);
          yield* f.request();
          const found = yield* f.repository.findOpen(captureThreadId, operation);
          expect(Option.isSome(found)).toBe(true);
          const returned = Option.getOrThrow(found);
          expect(returned.jobId).not.toBe(original.jobId);
          expect(returned.jobId).not.toBe(middle.jobId);
          expect((yield* f.read(original.jobId)).state).toBe("stale");
          expect(returned.contextJson).toBe(original.contextJson);
          expect(returned.deadlineAt).toBe(original.deadlineAt);
          expect(returned.modelWaitUntil).toBe(original.modelWaitUntil);
          expect(returned.nativeWaitUntil).toBe(original.nativeWaitUntil);
          expect((yield* f.read(middle.jobId)).state).toBe("stale");
          for (const attempt of [firstPrepared, middlePrepared]) {
            if (!attempt) continue;
            expect(yield* f.repository.claimDispatch(attempt, f.now())).toBe(false);
            expect((yield* f.repository.listAttempts(attempt.jobId))[0]?.state).toBe("stale");
          }
          yield* f.request();
          expect((yield* f.open).jobId).toBe(returned.jobId);
          yield* f.service.step(returned.jobId);
          yield* f.service.step(returned.jobId);
          expect((yield* f.read(returned.jobId)).state).toBe("completed");
          expect(yield* f.jobs).toHaveLength(3);
          expect(f.control.calls).toEqual(["model-a"]);
        }),
      ),
  );

  it.each(
    operations.flatMap((operation) =>
      (["failed", "uncertain"] as const).map((outcome) => ({ operation, outcome })),
    ),
  )("does not replenish $operation on A→B→A after B is $outcome", ({ operation, outcome }) =>
    captureLifecycleTest(operation, (f) =>
      Effect.gen(function* () {
        yield* f.request();
        const original = yield* f.open;
        yield* f.branch("workspace-b");
        yield* f.request();
        const middle = yield* f.open;
        f.control.outcome = outcome;
        yield* f.service.step(middle.jobId);
        yield* f.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("return-original-workspace"),
          threadId: captureThreadId,
          branch: null,
        });
        yield* f.service.step(middle.jobId);
        yield* f.request();
        yield* f.request();
        const found = yield* f.repository.findOpen(captureThreadId, operation);
        if (outcome === "failed") expect(Option.isNone(found)).toBe(true);
        else expect(Option.getOrThrow(found).jobId).toBe(middle.jobId);
        expect((yield* f.read(original.jobId)).state).toBe("stale");
        expect((yield* f.repository.listAttempts(middle.jobId))[0]?.state).toBe(outcome);
        expect(yield* f.jobs).toHaveLength(2);
        expect(f.control.calls).toEqual(["model-a"]);
      }),
    ),
  );
});
