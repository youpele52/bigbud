import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel } from "../../orchestration/projectorReadModel.ts";
import { ThreadDeletion, ThreadDeletionLive, resolveThreadSubtree } from "./ThreadDeletion.ts";

const thread = (id: string, parentThreadId?: string) =>
  ({
    id: ThreadId.makeUnsafe(id),
    deletedAt: null,
    ...(parentThreadId === undefined
      ? {}
      : {
          parentThread: {
            threadId: ThreadId.makeUnsafe(parentThreadId),
            projectId: "project-1",
            title: parentThreadId,
          },
        }),
  }) as OrchestrationThread;

describe("ThreadDeletion", () => {
  it("resolves a root and all descendants without selecting sibling subtrees", () => {
    const threads = [
      thread("root"),
      thread("child", "root"),
      thread("grandchild", "child"),
      thread("other"),
    ];

    expect(
      resolveThreadSubtree(ThreadId.makeUnsafe("root"), threads).map((entry) => entry.id),
    ).toEqual(["root", "child", "grandchild"]);
  });

  it("fences descendants and releases the fence when preflight skips the subtree", async () => {
    const deletion = await Effect.runPromise(
      Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
    );
    const threads = [thread("root"), thread("child", "root")];
    const readModel = { ...createEmptyReadModel(new Date().toISOString()), threads };

    await Effect.runPromise(deletion.acquireFence(ThreadId.makeUnsafe("root")));
    await expect(
      Effect.runPromise(deletion.isFenced({ threadId: ThreadId.makeUnsafe("child"), readModel })),
    ).resolves.toBe(true);
    await Effect.runPromise(deletion.releaseFence(ThreadId.makeUnsafe("root")));

    const result = await Effect.runPromise(
      deletion.deleteNow({
        rootThreadId: ThreadId.makeUnsafe("root"),
        resolveThreads: () => Effect.succeed(threads),
        preflight: () => Effect.succeed("pinned"),
        teardown: () => Effect.void,
        finalize: () => Effect.void,
      }),
    );

    expect(result).toEqual({ type: "skipped_pinned", threadIds: ["root", "child"] });
    await expect(
      Effect.runPromise(deletion.isFenced({ threadId: ThreadId.makeUnsafe("child"), readModel })),
    ).resolves.toBe(false);
  });

  it("rechecks the subtree before finalizing its complete deletion unit", async () => {
    const deletion = await Effect.runPromise(
      Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
    );
    const root = thread("root");
    const child = thread("child", "root");
    let threads = [root, child];
    const finalized: string[][] = [];

    const result = await Effect.runPromise(
      deletion.deleteNow({
        rootThreadId: ThreadId.makeUnsafe("root"),
        resolveThreads: () => Effect.sync(() => threads),
        preflight: () => {
          threads = [...threads, thread("late-child", "root")];
          return Effect.void;
        },
        teardown: () => Effect.void,
        finalize: (threadIds) => Effect.sync(() => finalized.push([...threadIds])),
      }),
    );

    expect(result.type).toBe("skipped_active");
    expect(result.threadIds.toSorted()).toEqual(["child", "late-child", "root"]);
    expect(finalized).toEqual([]);
  });
});
