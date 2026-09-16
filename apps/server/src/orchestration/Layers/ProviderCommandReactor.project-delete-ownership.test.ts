import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor project deletion ownership", () => {
  registerProviderCommandReactorTestCleanup();

  it("fails before a child cascade can remove a shared schedule or conversation", async () => {
    const harness = await createHarness();
    const projectId = asProjectId("project-1");
    const childThreadId = ThreadId.makeUnsafe("project-delete-owned-child");
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-project-delete-owned-child"),
        threadId: childThreadId,
        projectId,
        title: "Owned child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        parentThread: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          projectId,
          title: "New thread",
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES ('shared-project-delete-schedule', 'other-project', ${childThreadId},
          'Shared schedule', 'prompt', '* * * * *', 'UTC', ${now}, ${now})
      `,
    );
    await Effect.runPromise(
      harness.sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('project-delete-parent-message', 'thread-1', NULL, 'user', 'parent conversation', 0,
            ${now}, ${now}),
          ('project-delete-child-message', ${childThreadId}, NULL, 'assistant', 'child conversation', 0,
            ${now}, ${now})
      `,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("cmd-project-delete-shared-child"),
        projectId,
      }),
    );

    await waitFor(async () => {
      const model = await Effect.runPromise(harness.engine.getReadModel());
      return model.projects.find((project) => project.id === projectId)?.deletingAt === null;
    });
    await harness.drain();

    const model = await Effect.runPromise(harness.engine.getReadModel());
    expect(model.projects.find((project) => project.id === projectId)).toMatchObject({
      deletingAt: null,
      deletedAt: null,
    });
    expect(model.threads.map((thread) => thread.id)).toEqual(
      expect.arrayContaining([ThreadId.makeUnsafe("thread-1"), childThreadId]),
    );
    expect(
      await Effect.runPromise(
        harness.sql`SELECT automation_id FROM automation_schedules
          WHERE automation_id = 'shared-project-delete-schedule'`,
      ),
    ).toEqual([{ automation_id: "shared-project-delete-schedule" }]);
    expect(
      await Effect.runPromise(
        harness.sql`SELECT message_id, thread_id, text FROM projection_thread_messages
          WHERE message_id IN ('project-delete-parent-message', 'project-delete-child-message')
          ORDER BY message_id`,
      ),
    ).toEqual([
      {
        message_id: "project-delete-child-message",
        thread_id: childThreadId,
        text: "child conversation",
      },
      {
        message_id: "project-delete-parent-message",
        thread_id: "thread-1",
        text: "parent conversation",
      },
    ]);
  });
});
