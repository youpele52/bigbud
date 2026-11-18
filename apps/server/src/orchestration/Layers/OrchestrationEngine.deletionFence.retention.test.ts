import { CommandId, ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeDeletionFence } from "./OrchestrationEngine.deletionFence.ts";
import { ThreadDeletion, ThreadDeletionLive } from "../../deletion/Services/ThreadDeletion.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { asProjectId, now } from "./OrchestrationEngine.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("retention-fence-thread");

async function makeFence(deletingAt: string | null) {
  const deletion = await Effect.runPromise(
    Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
  );
  const readModel = {
    ...createEmptyReadModel(now()),
    threads: [
      {
        id: threadId,
        projectId: asProjectId("retention-fence-project"),
        deletingAt,
        deletedAt: null,
      } as OrchestrationThread,
    ],
  } as ReturnType<typeof createEmptyReadModel>;
  return {
    deletion,
    fence: makeDeletionFence({ threadDeletion: deletion, readModel: () => readModel }),
  };
}

const retentionDelete = (selectionMode: "per-thread" | "legacy-subtree") =>
  ({
    type: "thread.retention-delete",
    commandId: CommandId.makeUnsafe(`retention-fence-${selectionMode}`),
    threadId,
    runId: "retention-fence-run",
    selectionMode,
    expectedLastActivityAt: now(),
    cutoffAt: now(),
    createdAt: now(),
  }) as const;

describe("OrchestrationEngine deletion fence for retention", () => {
  it.each([
    ["per-thread", "single"],
    ["legacy-subtree", "subtree"],
  ] as const)(
    "holds a %s retention fence in the %s mode its deletion request uses",
    async (selectionMode, mode) => {
      const { deletion, fence } = await makeFence(now());
      await expect(Effect.runPromise(fence.acquire(retentionDelete(selectionMode)))).resolves.toBe(
        true,
      );
      expect(await Effect.runPromise(deletion.isFenceRoot(threadId, mode))).toBe(true);

      // A rejected command releases the fence it took.
      await Effect.runPromise(fence.releaseAfterProcess(retentionDelete(selectionMode), false));
      expect(await Effect.runPromise(deletion.isFenceRoot(threadId))).toBe(false);
    },
  );

  it("never releases a fence that a per-thread retention command found already held", async () => {
    const { deletion, fence } = await makeFence(now());
    expect(await Effect.runPromise(deletion.acquireFence(threadId, "single"))).toBe(true);

    const command = retentionDelete("per-thread");
    await expect(Effect.runPromise(fence.acquire(command))).resolves.toBe(true);
    await Effect.runPromise(fence.releaseAfterProcess(command, false));

    expect(await Effect.runPromise(deletion.isFenceRoot(threadId, "single"))).toBe(true);
  });
});
