import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ThreadId,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { asProjectId, createOrchestrationSystem, now } from "./OrchestrationEngine.test.helpers.ts";

const modelSelection = { provider: "codex" as const, model: "gpt-5-codex" };

describe("OrchestrationEngine deletion fence", () => {
  it("blocks child creation, prompts, and runtime startup until deletion aborts", async () => {
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
            type: "thread.create",
            commandId: CommandId.makeUnsafe("create-fenced-grandchild"),
            threadId: ThreadId.makeUnsafe("deletion-fence-grandchild"),
            projectId,
            title: "Grandchild",
            modelSelection,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            parentThread: { threadId: childThreadId, projectId, title: "Child" },
            createdAt,
          }),
        ),
      ).rejects.toThrow("ancestor is being deleted");
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
      ).rejects.toThrow("ancestor is being deleted");
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
      ).rejects.toThrow("ancestor is being deleted");

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
});
