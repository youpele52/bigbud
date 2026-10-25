import { assert } from "@effect/vitest";
import { Effect, Option } from "effect";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { asThreadId, makeProviderServiceLayer } from "./ProviderService.test.helpers.ts";

const harness = makeProviderServiceLayer();
harness.layer("retained explicit-stop native identity", (it) => {
  it.effect(
    "keeps opaque cursor/history binding while blocking implicit restart and permits explicit same-ID start",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService,
          directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("retained-stop"),
          cursor = { threadId: "native-retained", opaqueReplayEvidence: { must: "remain" } };
        yield* provider.startSession(threadId, {
          threadId,
          provider: "codex",
          cwd: "/fixture/worktree",
          resumeCursor: cursor,
          runtimeMode: "full-access",
        });
        yield* directory.upsert({
          threadId,
          provider: "codex",
          runtimePayload: { opaqueHistoryEvidence: "preserved" },
        });
        yield* provider.stopSession({ threadId });
        const binding = yield* directory.getBinding(threadId);
        assert.isTrue(Option.isSome(binding));
        if (Option.isNone(binding)) return;
        assert.deepEqual(binding.value.resumeCursor, cursor);
        assert.equal(binding.value.status, "stopped");
        assert.deepInclude(binding.value.runtimePayload, {
          opaqueHistoryEvidence: "preserved",
          explicitlyStopped: true,
        });
        harness.codex.startSession.mockClear();
        const failure = yield* Effect.flip(
          provider.sendTurn({ threadId, input: "not admitted", attachments: [] }),
        );
        assert.include(String(failure), "explicitly stopped");
        assert.equal(harness.codex.startSession.mock.calls.length, 0);
        const resumed = yield* provider.startSession(threadId, {
          threadId,
          provider: "codex",
          cwd: "/fixture/worktree",
          runtimeMode: "full-access",
        });
        assert.deepEqual(resumed.resumeCursor, cursor);
        const started = yield* directory.getBinding(threadId);
        if (Option.isSome(started))
          assert.deepInclude(started.value.runtimePayload, {
            explicitlyStopped: false,
            opaqueHistoryEvidence: "preserved",
          });
      }),
  );
});
