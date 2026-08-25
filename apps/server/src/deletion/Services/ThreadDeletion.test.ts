import { ThreadId, type OrchestrationThread } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel } from "../../orchestration/projectorReadModel.ts";
import {
  ThreadDeletion,
  ThreadDeletionLive,
  ThreadDeletionOperationError,
  resolveThreadSubtree,
} from "./ThreadDeletion.ts";

const thread = (id: string, parentThreadId?: string, projectId = "project-1") =>
  ({
    id: ThreadId.makeUnsafe(id),
    projectId,
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

  it("keeps cross-project descendants outside a subtree", () => {
    const threads = [
      thread("root"),
      thread("same-project-child", "root"),
      thread("other-project-child", "root", "project-2"),
    ];

    expect(
      resolveThreadSubtree(ThreadId.makeUnsafe("root"), threads).map((entry) => entry.id),
    ).toEqual(["root", "same-project-child"]);
  });

  it("does not fence descendants that belong to another project", async () => {
    const deletion = await Effect.runPromise(
      Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
    );
    const rootThreadId = ThreadId.makeUnsafe("root");
    const sameProjectChildId = ThreadId.makeUnsafe("same-project-child");
    const otherProjectChildId = ThreadId.makeUnsafe("other-project-child");
    const readModel = {
      ...createEmptyReadModel(new Date().toISOString()),
      threads: [
        thread("root"),
        thread("same-project-child", "root"),
        thread("other-project-child", "root", "project-2"),
      ],
    };

    await Effect.runPromise(deletion.acquireFence(rootThreadId, "subtree"));

    await expect(
      Effect.runPromise(deletion.isFenced({ threadId: sameProjectChildId, readModel })),
    ).resolves.toBe(true);
    await expect(
      Effect.runPromise(deletion.isFenced({ threadId: otherProjectChildId, readModel })),
    ).resolves.toBe(false);
  });

  it("selects only the requested thread in single mode", async () => {
    const deletion = await Effect.runPromise(
      Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
    );
    const threads = [thread("root"), thread("child", "root")];
    const finalized: string[][] = [];

    const result = await Effect.runPromise(
      deletion.deleteNow({
        rootThreadId: ThreadId.makeUnsafe("root"),
        mode: "single",
        resolveThreads: () => Effect.succeed(threads),
        preflight: () => Effect.void,
        teardown: () => Effect.void,
        finalize: (threadIds) => Effect.sync(() => finalized.push([...threadIds])),
      }),
    );

    expect(result).toEqual({ type: "deleted", threadIds: ["root"] });
    expect(finalized).toEqual([["root"]]);
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

  it("upgrades a single-thread fence when subtree deletion takes ownership", async () => {
    const deletion = await Effect.runPromise(
      Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
    );
    const rootThreadId = ThreadId.makeUnsafe("root");
    const childThreadId = ThreadId.makeUnsafe("child");
    const readModel = {
      ...createEmptyReadModel(new Date().toISOString()),
      threads: [thread("root"), thread("child", "root")],
    };

    await expect(Effect.runPromise(deletion.acquireFence(rootThreadId, "single"))).resolves.toBe(
      true,
    );
    await expect(Effect.runPromise(deletion.isFenceRoot(rootThreadId, "subtree"))).resolves.toBe(
      false,
    );
    await expect(Effect.runPromise(deletion.acquireFence(rootThreadId, "subtree"))).resolves.toBe(
      true,
    );
    await expect(
      Effect.runPromise(deletion.isFenced({ threadId: childThreadId, readModel })),
    ).resolves.toBe(true);
    await Effect.runPromise(deletion.releaseFence(rootThreadId, "single"));
    await expect(Effect.runPromise(deletion.isFenceRoot(rootThreadId, "subtree"))).resolves.toBe(
      true,
    );
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

  it("keeps the last known subtree ids when teardown fails", async () => {
    const deletion = await Effect.runPromise(
      Effect.service(ThreadDeletion).pipe(Effect.provide(ThreadDeletionLive)),
    );
    const threads = [thread("root"), thread("child", "root")];

    const result = await Effect.runPromise(
      deletion.deleteNow({
        rootThreadId: ThreadId.makeUnsafe("root"),
        resolveThreads: () => Effect.succeed(threads),
        preflight: () => Effect.void,
        teardown: () =>
          Effect.fail(new ThreadDeletionOperationError({ detail: "provider stop failed" })),
        finalize: () => Effect.void,
      }),
    );

    expect(result.type).toBe("failed");
    expect(result.threadIds.toSorted()).toEqual(["child", "root"]);
  });
});
