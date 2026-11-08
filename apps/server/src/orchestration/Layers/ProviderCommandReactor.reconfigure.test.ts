import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MUSE_WORKSPACE_RESET_NOTICE } from "../ProjectWorkspace.nativeSessions.ts";

import {
  asMessageId,
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor SSH reconfiguration", () => {
  registerProviderCommandReactorTestCleanup();

  it.each(["ready", "stopped"] as const)(
    "refreshes a %s local session cwd without rewriting messages",
    async (status) => {
      // Reconfiguration verifies the current folder too, so both ends must exist on disk.
      const source = await mkdtemp(join(tmpdir(), "bigbud-session-cwd-source-"));
      const harness = await createHarness({ workspaceRoot: source });
      const destination = await mkdtemp(join(tmpdir(), "bigbud-session-cwd-"));
      try {
        await startSession(harness, new Date().toISOString(), status);
        const model = await Effect.runPromise(harness.engine.getReadModel());
        const project = model.projects.find((entry) => entry.id === asProjectId("project-1"))!;
        const messages = (await getThread(harness))!.messages;
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "project.reconfigure",
            commandId: CommandId.makeUnsafe("local-cwd-change"),
            projectId: project.id,
            title: project.title,
            workspaceRoot: destination,
            providerRuntimeExecutionTargetId: "local",
            workspaceExecutionTargetId: "local",
            executionTargetId: "local",
            expectedUpdatedAt: project.updatedAt,
            verifiedWorktreePaths: [],
          }),
        );
        await waitFor(() => harness.startSession.mock.calls.length === 2);
        expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({ cwd: destination });
        expect(harness.stopSession).toHaveBeenCalledTimes(status === "ready" ? 1 : 0);
        expect((await getThread(harness))!.messages).toEqual(messages);
      } finally {
        await rm(destination, { recursive: true, force: true });
        await rm(source, { recursive: true, force: true });
      }
    },
  );

  it("does not recreate an archived Muse session on metadata refresh", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    await startSession(harness, createdAt, "stopped");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("archived-muse"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt,
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "stopped",
          providerName: "muse",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: MUSE_WORKSPACE_RESET_NOTICE,
          updatedAt: createdAt,
        },
      }),
    );
    await reconfigureProject(harness);
    await harness.drain();
    expect(harness.startSession).toHaveBeenCalledOnce();
    expect(harness.stopSession).not.toHaveBeenCalled();
    expect((await getThread(harness))?.session).toMatchObject({
      status: "stopped",
      providerName: "muse",
      lastError: MUSE_WORKSPACE_RESET_NOTICE,
    });
    expect((await getThread(harness))?.modelSelection).toMatchObject({ provider: "codex" });
  });

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
  status: "ready" | "stopped" = "ready",
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
  await harness.drain();
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("cmd-reconfigure-session-ready"),
      threadId: ThreadId.makeUnsafe("thread-1"),
      session: {
        threadId: ThreadId.makeUnsafe("thread-1"),
        status,
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    }),
  );
  await waitFor(async () => (await getThread(harness))?.session?.status === status);
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
