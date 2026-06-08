import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asProjectId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor", () => {
  registerProviderCommandReactorTestCleanup();

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.makeUnsafe("cmd-session-stop"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("reacts to thread.deletion-requested by stopping provider, browser, and terminal before final delete", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.startSession(ThreadId.makeUnsafe("thread-1"), {
        threadId: ThreadId.makeUnsafe("thread-1"),
        provider: "codex",
        runtimeMode: "approval-required",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-delete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-delete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(() => harness.browserClose.mock.calls.length === 1);
    await waitFor(() => harness.terminalClose.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))
          ?.deletedAt !== null
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.deletingAt).toBeNull();
    expect(thread?.deletedAt).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
  });

  it("aborts thread deletion when cleanup fails and leaves the thread undeleted", async () => {
    const harness = await createHarness({
      browserCloseFailure: "browser close failed",
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.startSession(ThreadId.makeUnsafe("thread-1"), {
        threadId: ThreadId.makeUnsafe("thread-1"),
        provider: "codex",
        runtimeMode: "approval-required",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-delete-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.makeUnsafe("cmd-thread-delete-failure"),
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(() => harness.browserClose.mock.calls.length === 1);
    await waitFor(() => harness.terminalClose.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      const thread = readModel.threads.find(
        (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
      );
      return (
        thread?.deletingAt === null &&
        thread.deletedAt === null &&
        thread.activities.some((activity) => activity.kind === "thread.delete.failed")
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.deletedAt).toBeNull();
    expect(thread?.deletingAt).toBeNull();
    expect(thread?.activities.some((activity) => activity.kind === "thread.delete.failed")).toBe(
      true,
    );
  });

  it("reacts to project.delete by deleting live child threads before final project delete", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.startSession(ThreadId.makeUnsafe("thread-1"), {
        threadId: ThreadId.makeUnsafe("thread-1"),
        provider: "codex",
        runtimeMode: "approval-required",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-for-project-delete"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.delete",
        commandId: CommandId.makeUnsafe("cmd-project-delete-live-thread"),
        projectId: asProjectId("project-1"),
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    await waitFor(() => harness.browserClose.mock.calls.length === 1);
    await waitFor(() => harness.terminalClose.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.projects.find((project) => project.id === asProjectId("project-1"))?.deletedAt !==
        null
      );
    });

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const project = readModel.projects.find((entry) => entry.id === asProjectId("project-1"));
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(project?.deletedAt).not.toBeNull();
    expect(project?.deletingAt).toBeNull();
    expect(thread?.deletedAt).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
  });
});
