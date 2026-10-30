import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import {
  codexReliabilityHarness,
  exactRewindInput,
} from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import {
  prepareCodexRewind,
  revertCodexThread,
  verifyCodexRewind,
} from "../../codex/codexAppServerManager.rewind.ts";
import { CodexRpcError } from "../../codex/codexAppServerManager.errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderPreparedRewind, CodexRewindMarker } from "../Services/ProviderRewind.ts";
import { CODEX_REWIND_KEY } from "../Services/ProviderRewind.ts";
import { ProviderValidationError } from "../Errors.ts";
import { toRequestError } from "./Codex/Adapter.session.shared.ts";
import { makeRewindConversation } from "./ProviderService.rewind.ts";
import { makeThreadOperations } from "./ProviderService.threadOperations.ts";

const layer = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory))),
);

it.layer(layer)("exact native rewind through durable coordinated completion", (it) => {
  for (const outcome of ["success", "commit-then-error", "canonical-failure"] as const) {
    it(outcome, () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const { context, state, ops, sendRequest } = codexReliabilityHarness();
        if (outcome === "commit-then-error") {
          const normal = sendRequest.getMockImplementation()!;
          sendRequest.mockImplementation(async (ctx, method, params) => {
            const result = await normal(ctx, method, params);
            if (method === "thread/revert")
              throw new CodexRpcError(method, 2, "possibly-applied", "reload acknowledgement lost");
            return result;
          });
        }
        const request = <A>(run: () => Promise<A>) =>
          Effect.tryPromise({
            try: run,
            catch: (cause) => toRequestError(exactRewindInput.threadId, "thread/revert", cause),
          });
        const registry = {
          getByProvider: () =>
            Effect.succeed({
              prepareRewind: (input: ProviderPreparedRewind) =>
                request(() => prepareCodexRewind(context, input, ops)),
              revertThread: (input: ProviderPreparedRewind) =>
                request(() => revertCodexThread(context, input, ops)).pipe(Effect.asVoid),
              verifyRewind: (input: ProviderPreparedRewind) =>
                request(() => verifyCodexRewind(context, input, ops)).pipe(Effect.asVoid),
            }),
        } as unknown as ProviderAdapterRegistryShape;
        const threadId = exactRewindInput.threadId;
        yield* directory.upsert({
          threadId,
          provider: "codex",
          resumeCursor: { threadId: "native" },
          runtimePayload: { sessionEpoch: 2 },
        });
        const readMarker = directory
          .getBinding(threadId)
          .pipe(
            Effect.map(
              (binding) =>
                (Option.getOrThrow(binding).runtimePayload as Record<string, unknown>)[
                  CODEX_REWIND_KEY
                ] as CodexRewindMarker | undefined,
            ),
          );
        const applied: string[] = [];
        const completion = {
          preflight: Effect.void,
          restoreFiles: Effect.gen(function* () {
            assert.deepEqual(
              state.turns.map((turn) => turn.id),
              ["t1"],
            );
            assert.equal((yield* readMarker)?.stage, "native-verified");
            applied.push("files");
          }),
          completeCanonical: Effect.gen(function* () {
            assert.equal((yield* readMarker)?.stage, "files-restored");
            if (outcome === "canonical-failure")
              return yield* new ProviderValidationError({
                operation: "test.canonical",
                issue: "publication failed",
              });
            applied.push("canonical");
          }),
        };
        const run = makeThreadOperations(directory);
        const rewind = makeRewindConversation(registry, directory);
        const result = yield* run(threadId, rewind(exactRewindInput, completion)).pipe(
          Effect.result,
        );
        if (outcome === "canonical-failure") {
          assert.equal(result._tag, "Failure");
          assert.equal((yield* readMarker)?.stage, "files-restored");
          const replay = yield* run(threadId, rewind(exactRewindInput, completion)).pipe(
            Effect.result,
          );
          assert.equal(replay._tag, "Failure");
          assert.deepEqual(applied, ["files"]);
        } else {
          assert.equal(result._tag, "Success");
          assert.equal(yield* readMarker, undefined);
          assert.deepEqual(applied, ["files", "canonical"]);
        }
        assert.equal(
          sendRequest.mock.calls.filter((call) => call[1] === "thread/revert").length,
          1,
        );
      }),
    );
  }
});
