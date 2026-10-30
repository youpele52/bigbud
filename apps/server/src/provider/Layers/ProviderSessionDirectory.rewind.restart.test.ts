import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option } from "effect";
import { expect, it, vi } from "vitest";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { CODEX_REWIND_KEY, type CodexRewindMarker } from "../Services/ProviderRewind.ts";
import { exactRewindInput } from "../../codex/codexAppServerManager.reliability.test.helpers.ts";
import { makeThreadOperations } from "./ProviderService.threadOperations.ts";

it("rehydrates the exact operation fence after database/layer restart before admitting work", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-codex-rewind-"));
  const persistence = makeSqlitePersistenceLive(path.join(temp, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const layer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(persistence))),
  );
  const marker: CodexRewindMarker = {
    ...exactRewindInput,
    nativeThreadId: "native",
    runtimeVersion: "0.166.0",
    stage: "dispatched-uncertain",
  };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          threadId: exactRewindInput.threadId,
          provider: "codex",
          runtimePayload: { sessionEpoch: 2 },
          resumeCursor: { threadId: "native" },
        });
        yield* directory.setCodexRewind!(exactRewindInput.threadId, marker, marker.operationId);
      }).pipe(Effect.provide(layer)),
    );
    const dispatch = vi.fn();
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const binding = Option.getOrThrow(yield* directory.getBinding(exactRewindInput.threadId));
        expect((binding.runtimePayload as Record<string, unknown>)[CODEX_REWIND_KEY]).toEqual(
          marker,
        );
        const result = yield* makeThreadOperations(directory)(
          exactRewindInput.threadId,
          Effect.sync(dispatch),
        ).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        yield* directory.remove(exactRewindInput.threadId);
        yield* directory.upsert({
          threadId: exactRewindInput.threadId,
          provider: "codex",
          runtimePayload: { sessionEpoch: 3 },
        });
        expect(
          (
            Option.getOrThrow(yield* directory.getBinding(exactRewindInput.threadId))
              .runtimePayload as Record<string, unknown>
          )[CODEX_REWIND_KEY],
        ).toEqual(marker);
      }).pipe(Effect.provide(layer)),
    );
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
