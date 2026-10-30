import { assert } from "@effect/vitest";
import { Effect, Option } from "effect";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { CODEX_REWIND_KEY, type CodexRewindMarker } from "../Services/ProviderRewind.ts";
import { exactRewindInput } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import { makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const test = makeProviderServiceLayer();

test.layer("Codex rewind admission fencing", (it) => {
  it.effect(
    "blocks starts, sends, steer, and rewind across stop/rebind without recovering or dispatching",
    () =>
      Effect.gen(function* () {
        const service = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const { threadId } = exactRewindInput;
        const marker: CodexRewindMarker = { ...exactRewindInput, stage: "files-restored" };
        yield* directory.upsert({
          threadId,
          provider: "codex",
          runtimePayload: { sessionEpoch: 2 },
          resumeCursor: { threadId: "native" },
        });
        yield* directory.setCodexRewind!(threadId, marker, marker.operationId);
        const starts = test.codex.startSession.mock.calls.length;
        const sends = test.codex.sendTurn.mock.calls.length;
        const start = {
          threadId,
          provider: "codex" as const,
          runtimeMode: "full-access" as const,
          sessionEpoch: 2,
        };
        const operations = [
          service.startSession(threadId, start),
          service.startSessionFresh(threadId, start),
          service.sendTurn({ threadId, input: "never replay", sessionEpoch: 2 }),
          service.steerTurn!({ threadId, input: "never steer", sessionEpoch: 2 }),
          service.rollbackConversation({ threadId, numTurns: 1 }),
          service.rewindConversation!(exactRewindInput, {
            preflight: Effect.void,
            restoreFiles: Effect.void,
            completeCanonical: Effect.void,
          }),
        ];
        for (const operation of operations)
          assert.equal((yield* operation.pipe(Effect.result))._tag, "Failure");
        yield* service.stopSession({ threadId, sessionEpoch: 2 });
        const stopped = Option.getOrThrow(yield* directory.getBinding(threadId));
        assert.deepEqual(
          (stopped.runtimePayload as Record<string, unknown>)[CODEX_REWIND_KEY],
          marker,
        );
        yield* directory.upsert({
          threadId,
          provider: "codex",
          runtimePayload: { sessionEpoch: 3 },
        });
        assert.equal(
          (yield* service
            .startSessionFresh(threadId, { ...start, sessionEpoch: 3 })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(test.codex.startSession.mock.calls.length, starts);
        assert.equal(test.codex.sendTurn.mock.calls.length, sends);
      }),
  );
});
