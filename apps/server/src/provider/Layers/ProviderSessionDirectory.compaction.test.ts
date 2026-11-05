import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import {
  CODEX_COMPACTIONS_KEY,
  readCodexCompactionProofs,
} from "../Services/ProviderCompaction.ts";
import { exactRewindInput } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import { CODEX_REWIND_KEY } from "../Services/ProviderRewind.ts";
import { INSPECTION_TERMINAL_KEY } from "../Services/ProviderInspectionTerminal.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

const repositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const layer = ProviderSessionDirectoryLive.pipe(Layer.provideMerge(repositoryLayer));
const proof = {
  threadId: exactRewindInput.threadId,
  sessionEpoch: 2,
  nativeThreadId: "native",
  turnId: "manual",
  itemId: "compact-item",
};

it.layer(layer)("durable native manual compaction proofs", (it) => {
  it("preserves concurrent append operations across stale directory/raw lifecycle replacements", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntimeRepository;
      yield* directory.upsert({
        threadId: proof.threadId,
        provider: "codex",
        resumeCursor: { threadId: "native" },
        runtimePayload: { sessionEpoch: 2 },
      });
      const stale = Option.getOrThrow(
        yield* repository.getByThreadId({ threadId: proof.threadId }),
      );
      yield* Effect.all(
        [
          directory.recordCodexCompaction!(proof),
          directory.recordCodexCompaction!({ ...proof, turnId: "manual2", itemId: "compact2" }),
          repository.upsert({
            ...stale,
            runtimePayload: { sessionEpoch: 2, [CODEX_COMPACTIONS_KEY]: { spoof: true } },
          }),
          directory.upsert({
            threadId: proof.threadId,
            provider: "codex",
            runtimePayload: { lastRuntimeEvent: "turn/completed" },
          }),
        ],
        { concurrency: "unbounded" },
      );
      const current = Option.getOrThrow(yield* directory.getBinding(proof.threadId));
      assert.deepEqual(readCodexCompactionProofs(current.runtimePayload, "native"), {
        manual: "compact-item",
        manual2: "compact2",
      });
      yield* repository.upsert({ ...stale, runtimePayload: null });
      assert.deepEqual(
        readCodexCompactionProofs(
          Option.getOrThrow(yield* directory.getBinding(proof.threadId)).runtimePayload,
          "native",
        ),
        { manual: "compact-item", manual2: "compact2" },
      );
    }));
  it("is idempotent but refuses conflicting native item identity", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: proof.threadId,
        provider: "codex",
        resumeCursor: { threadId: "native" },
        runtimePayload: { sessionEpoch: 2 },
      });
      yield* directory.recordCodexCompaction!(proof);
      yield* directory.recordCodexCompaction!(proof);
      assert.equal(
        (yield* directory.recordCodexCompaction!({ ...proof, itemId: "different" }).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.deepEqual(
        readCodexCompactionProofs(
          Option.getOrThrow(yield* directory.getBinding(proof.threadId)).runtimePayload,
          "native",
        ),
        { manual: "compact-item" },
      );
    }));
  it("survives resume epoch changes without admitting stale owners or crossing native threads", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        threadId: proof.threadId,
        provider: "codex",
        resumeCursor: { threadId: "native" },
        runtimePayload: { sessionEpoch: 2 },
      });
      yield* directory.recordCodexCompaction!(proof);
      yield* directory.upsert({
        threadId: proof.threadId,
        provider: "codex",
        runtimePayload: { sessionEpoch: 3 },
      });
      assert.equal(
        (yield* directory.recordCodexCompaction!({ ...proof, turnId: "stale" }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      yield* directory.recordCodexCompaction!({
        ...proof,
        sessionEpoch: 3,
        turnId: "resumed",
        itemId: "new-item",
      });
      const resumed = Option.getOrThrow(yield* directory.getBinding(proof.threadId));
      assert.deepEqual(readCodexCompactionProofs(resumed.runtimePayload, "native"), {
        manual: "compact-item",
        resumed: "new-item",
      });
      assert.deepEqual(readCodexCompactionProofs(resumed.runtimePayload, "other-native"), {});
      assert.equal(
        (yield* directory.recordCodexCompaction!({
          ...proof,
          sessionEpoch: 3,
          nativeThreadId: "other-native",
        }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* directory.upsert({
        threadId: proof.threadId,
        provider: "codex",
        resumeCursor: { threadId: "other-native" },
        runtimePayload: { sessionEpoch: 4 },
      });
      yield* directory.recordCodexCompaction!({
        ...proof,
        sessionEpoch: 4,
        nativeThreadId: "other-native",
        itemId: "other-item",
      });
      const changed = Option.getOrThrow(yield* directory.getBinding(proof.threadId));
      assert.deepEqual(readCodexCompactionProofs(changed.runtimePayload, "native"), {
        manual: "compact-item",
        resumed: "new-item",
      });
      assert.deepEqual(readCodexCompactionProofs(changed.runtimePayload, "other-native"), {
        manual: "other-item",
      });
    }));
  it("does not bypass durable rewind or unpublished terminal fences", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      for (const key of [CODEX_REWIND_KEY, INSPECTION_TERMINAL_KEY]) {
        const threadId = ThreadId.makeUnsafe(`fenced-${key}`);
        yield* directory.upsert({
          threadId,
          provider: "codex",
          resumeCursor: { threadId: "native" },
          runtimePayload: { sessionEpoch: 2, [key]: { incomplete: true } },
        });
        assert.equal(
          (yield* directory.recordCodexCompaction!({ ...proof, threadId }).pipe(Effect.result))
            ._tag,
          "Failure",
        );
      }
    }));
});
