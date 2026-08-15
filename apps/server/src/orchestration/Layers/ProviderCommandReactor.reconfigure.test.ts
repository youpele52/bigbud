import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor SSH reconfiguration", () => {
  registerProviderCommandReactorTestCleanup();

  it("projects a session error when stopping the old provider binding fails", async () => {
    const harness = await createHarness({ stopSessionFailure: "old target remains reachable" });
    const now = new Date().toISOString();

    await startSession(harness, now);
    await reconfigureProject(harness);

    await waitFor(async () => (await getThread(harness))?.session?.status === "error");

    const thread = await getThread(harness);
    expect(harness.stopSession).toHaveBeenCalledOnce();
    expect(harness.startSession).toHaveBeenCalledOnce();
    expect(thread).toMatchObject({
      providerRuntimeExecutionTargetId: "ssh:host=new-host&auth=ssh-key",
      workspaceExecutionTargetId: "ssh:host=new-host&auth=ssh-key",
      session: {
        status: "error",
        providerName: "codex",
        lastError: expect.stringContaining("old target remains reachable"),
      },
    });
  });

  it("projects a session error when creating the fresh provider binding fails", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await startSession(harness, now);
    harness.startSession.mockImplementationOnce(
      () => Effect.fail(new Error("new target is unavailable")) as never,
    );

    await reconfigureProject(harness);

    await waitFor(async () => (await getThread(harness))?.session?.status === "error");

    const thread = await getThread(harness);
    expect(harness.stopSession).toHaveBeenCalledOnce();
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(thread).toMatchObject({
      providerRuntimeExecutionTargetId: "ssh:host=new-host&auth=ssh-key",
      workspaceExecutionTargetId: "ssh:host=new-host&auth=ssh-key",
      session: {
        status: "error",
        providerName: "codex",
        lastError: expect.stringContaining("new target is unavailable"),
      },
    });
  });
});

async function startSession(
  harness: Awaited<ReturnType<typeof createHarness>>,
  createdAt: string,
): Promise<void> {
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("cmd-reconfigure-session-start"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      message: {
        messageId: asMessageId("message-reconfigure-session-start"),
        role: "user",
        text: "start the provider session",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      createdAt,
    }),
  );
  await waitFor(() => harness.startSession.mock.calls.length === 1);
}

async function reconfigureProject(
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<void> {
  const project = (await Effect.runPromise(harness.engine.getReadModel())).projects.find(
    (entry) => entry.id === asProjectId("project-1"),
  );
  if (!project) {
    throw new Error("Expected project test fixture to exist.");
  }

  await Effect.runPromise(
    harness.engine.dispatch({
      type: "project.reconfigure",
      commandId: CommandId.makeUnsafe("cmd-project-reconfigure"),
      projectId: project.id,
      title: project.title,
      providerRuntimeExecutionTargetId: "ssh:host=new-host&auth=ssh-key",
      workspaceExecutionTargetId: "ssh:host=new-host&auth=ssh-key",
      executionTargetId: "ssh:host=new-host&auth=ssh-key",
      workspaceRoot: "/srv/project",
      expectedUpdatedAt: project.updatedAt,
      verifiedWorktreePaths: [],
    }),
  );
}

async function getThread(harness: Awaited<ReturnType<typeof createHarness>>) {
  const readModel = await Effect.runPromise(harness.engine.getReadModel());
  return readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
}
