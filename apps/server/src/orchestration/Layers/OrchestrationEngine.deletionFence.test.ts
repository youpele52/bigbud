import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeDeletionFence } from "./OrchestrationEngine.deletionFence.ts";
import type { ThreadDeletionShape } from "../../deletion/Services/ThreadDeletion.ts";
import { createEmptyReadModel } from "../projectorReadModel.ts";
import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };

describe("OrchestrationEngine deletion fence", () => {
  it("blocks the deleting thread while allowing existing descendants to continue", async () => {
    const system = await createOrchestrationSystem();
    const projectId = asProjectId("deletion-fence-project");
    const rootThreadId = ThreadId.makeUnsafe("deletion-fence-root");
    const childThreadId = ThreadId.makeUnsafe("deletion-fence-child");
    const createdAt = now();

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("create-deletion-fence-project"),
          projectId,
          title: "Deletion fence",
          workspaceRoot: "/tmp/deletion-fence",
          defaultModelSelection: modelSelection,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-deletion-fence-root"),
          threadId: rootThreadId,
          projectId,
          title: "Root",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-deletion-fence-child"),
          threadId: childThreadId,
          projectId,
          title: "Child",
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          parentThread: { threadId: rootThreadId, projectId, title: "Root" },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("delete-deletion-fence-root"),
          threadId: rootThreadId,
        }),
      );
      expect(await system.run(system.engine.threadDeletion!.isFenceRoot(rootThreadId))).toBe(true);

      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("prompt-fenced-root"),
            threadId: rootThreadId,
            message: {
              messageId: MessageId.makeUnsafe("fenced-root-message"),
              role: "user",
              text: "blocked",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        ),
      ).rejects.toThrow("being deleted");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("create-child-on-fenced-root"),
            threadId: ThreadId.makeUnsafe("deletion-fence-late-child"),
            projectId,
            title: "Late child",
            modelSelection,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            parentThread: { threadId: rootThreadId, projectId, title: "Root" },
            createdAt,
          }),
        ),
      ).rejects.toThrow("being deleted");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("prompt-fenced-child"),
            threadId: childThreadId,
            message: {
              messageId: MessageId.makeUnsafe("fenced-child-message"),
              role: "user",
              text: "blocked",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            createdAt,
          }),
        ),
      ).resolves.toBeDefined();
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("start-fenced-child-runtime"),
            threadId: childThreadId,
            session: {
              threadId: childThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ).resolves.toBeDefined();

      await system.run(
        system.engine.dispatch({
          type: "thread.delete.abort",
          commandId: CommandId.makeUnsafe("abort-deletion-fence-root"),
          threadId: rootThreadId,
          createdAt,
        }),
      );
      expect(await system.run(system.engine.threadDeletion!.isFenceRoot(rootThreadId))).toBe(false);
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("start-child-after-delete-abort"),
            threadId: childThreadId,
            session: {
              threadId: childThreadId,
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        ),
      ).resolves.toBeDefined();
    } finally {
      await system.dispose();
    }
  });

  it("upgrades a single fence before accepting retention for an already deleting thread", async () => {
    const rootThreadId = ThreadId.makeUnsafe("retention-upgrade-root");
    let mode: "single" | "subtree" = "single";
    const threadDeletion = {
      acquireFence: (_threadId: ThreadId, requestedMode = "subtree" as const) =>
        Effect.sync(() => {
          if (mode === "single" && requestedMode === "subtree") mode = "subtree";
          return true;
        }),
      isFenceRoot: (_threadId: ThreadId, requiredMode?: "single" | "subtree") =>
        Effect.succeed(requiredMode === undefined || mode === requiredMode),
    } as const;
    const readModel = {
      ...createEmptyReadModel(now()),
      threads: [
        {
          id: rootThreadId,
          projectId: asProjectId("retention-upgrade-project"),
          deletingAt: now(),
          deletedAt: null,
        } as OrchestrationThread,
      ],
    } as ReturnType<typeof createEmptyReadModel>;
    const fence = makeDeletionFence({
      threadDeletion: threadDeletion as unknown as ThreadDeletionShape,
      readModel: () => readModel,
    });

    await expect(
      Effect.runPromise(
        fence.acquire({
          type: "thread.retention-delete",
          commandId: CommandId.makeUnsafe("retention-upgrade-command"),
          threadId: rootThreadId,
          runId: "retention-upgrade-run",
          expectedLastActivityAt: now(),
          cutoffAt: now(),
          createdAt: now(),
        }),
      ),
    ).resolves.toBe(true);
    expect(mode).toBe("subtree");
  });
});
