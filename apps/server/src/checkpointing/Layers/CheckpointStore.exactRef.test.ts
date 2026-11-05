import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import {
  createHarness,
  registerCheckpointReactorTestCleanup,
} from "../../orchestration/Layers/CheckpointReactor.test.helpers.ts";
import { checkpointRefForThreadTurn, legacyCheckpointRefForThreadTurn } from "../Utils.ts";

describe("exact checkpoint ref qualification", () => {
  registerCheckpointReactorTestCleanup();
  it("does not qualify a missing exact ref using a compatibility alias", async () => {
    const h = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const current = checkpointRefForThreadTurn(threadId, 0);
    const legacy = legacyCheckpointRefForThreadTurn(threadId, 0);
    await Effect.runPromise(
      h.checkpointStore.captureCheckpoint({ cwd: h.cwd, checkpointRef: legacy }),
    );
    const identity = await Effect.runPromise(h.checkpointStore.captureRepositoryIdentity(h.cwd));
    expect(
      await Effect.runPromise(
        h.checkpointStore.hasCheckpointRef({ cwd: h.cwd, checkpointRef: current }),
      ),
    ).toBe(true);
    expect(
      await Effect.runPromise(
        h.checkpointStore.hasCheckpointRef({
          cwd: h.cwd,
          checkpointRef: current,
          exactRef: true,
          identity,
        }),
      ),
    ).toBe(false);
    expect(
      await Effect.runPromise(
        h.checkpointStore.restoreCheckpoint({
          cwd: h.cwd,
          checkpointRef: current,
          exactRef: true,
          identity,
          fallbackToHead: false,
        }),
      ),
    ).toBe(false);
  });
});
