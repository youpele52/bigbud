import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { CODEX_REWIND_KEY, type CodexRewindMarker } from "../Services/ProviderRewind.ts";
import { exactRewindInput } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";

const repositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const layer = ProviderSessionDirectoryLive.pipe(Layer.provideMerge(repositoryLayer));
const marker: CodexRewindMarker = {
  ...exactRewindInput,
  nativeThreadId: "native",
  runtimeVersion: "0.166.0",
  stage: "dispatched-uncertain",
};

it.layer(layer)("durable Codex rewind namespace", (it) => {
  it("survives concurrent lifecycle writes, raw repository replacements, removal, and rebind", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntimeRepository;
      const threadId = exactRewindInput.threadId;
      yield* directory.upsert({ threadId, provider: "codex", runtimePayload: { sessionEpoch: 2 } });
      const row = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      yield* Effect.all(
        [
          directory.setCodexRewind!(threadId, marker, marker.operationId),
          directory.upsert({
            threadId,
            provider: "codex",
            runtimePayload: { lastRuntimeEvent: "turn/completed" },
          }),
          repository.upsert({ ...row, runtimePayload: { activeTurnId: null } }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(
        (
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload as Record<
            string,
            unknown
          >
        )[CODEX_REWIND_KEY],
        marker,
      );
      yield* directory.remove(threadId);
      yield* repository.deleteByThreadId({ threadId });
      yield* directory.upsert({ threadId, provider: "codex", runtimePayload: { sessionEpoch: 3 } });
      const rebound = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.deepEqual(
        (rebound.runtimePayload as Record<string, unknown>)[CODEX_REWIND_KEY],
        marker,
      );
    }));

  it("clear is operation/stage fenced and stale writers cannot resurrect it", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntimeRepository;
      const threadId = exactRewindInput.threadId;
      yield* directory.upsert({ threadId, provider: "codex", runtimePayload: { sessionEpoch: 2 } });
      yield* directory.setCodexRewind!(threadId, marker, marker.operationId);
      const early = yield* directory.setCodexRewind!(threadId, null, marker.operationId).pipe(
        Effect.result,
      );
      assert.equal(early._tag, "Failure");
      const wrong = yield* directory.setCodexRewind!(threadId, null, "other-operation").pipe(
        Effect.result,
      );
      assert.equal(wrong._tag, "Failure");
      yield* directory.setCodexRewind!(
        threadId,
        { ...marker, stage: "canonical-complete" },
        marker.operationId,
      );
      const stale = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      yield* directory.setCodexRewind!(threadId, null, marker.operationId);
      yield* Effect.all(
        [
          directory.upsert({ threadId, provider: "codex", runtimePayload: stale.runtimePayload }),
          repository.upsert(stale),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(
        (
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload as Record<
            string,
            unknown
          >
        )[CODEX_REWIND_KEY],
        undefined,
      );
    }));
});
