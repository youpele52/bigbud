import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeDispatchShellCommand } from "./wsShellDispatch";

const modelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5.4",
};

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };

  return poll();
}

const makeReadModel = (threadId: ThreadId | null, projectWorkspaceRoot: string | null) => {
  const createdAt = new Date().toISOString();
  const projectId = ProjectId.makeUnsafe("project-shell-dispatch");
  return {
    snapshotSequence: 0,
    updatedAt: createdAt,
    projects: [
      {
        id: projectId,
        title: "Chats",
        executionTargetId: "local",
        workspaceRoot: projectWorkspaceRoot,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
        deletingAt: null,
        deletedAt: null,
      },
    ],
    threads:
      threadId === null
        ? []
        : [
            {
              id: threadId,
              projectId,
              title: "Shell thread",
              executionTargetId: "local",
              modelSelection,
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "full-access" as const,
              branch: null,
              worktreePath: null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              latestTurn: null,
              messages: [],
              session: null,
              activities: [],
              proposedPlans: [],
              checkpoints: [],
              deletedAt: null,
            },
          ],
  } satisfies OrchestrationReadModel;
};

describe("makeDispatchShellCommand", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("waits for a bootstrapped thread to appear before running the shell command", async () => {
    const defaultChatCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-shell-bootstrap-"));
    tempDirs.add(defaultChatCwd);
    const threadId = ThreadId.makeUnsafe("thread-shell-bootstrap");
    const readModels = [makeReadModel(null, null), makeReadModel(threadId, null)];
    let readModelIndex = 0;
    const dispatchedCommands: OrchestrationCommand[] = [];

    const dispatchShellCommand = makeDispatchShellCommand({
      enqueueCommand: (effect) => effect,
      dispatchInitialShellCommand: () => Effect.succeed({ sequence: 1 }),
      orchestrationEngine: {
        dispatch: (command) =>
          Effect.sync(() => {
            dispatchedCommands.push(command);
            return { sequence: dispatchedCommands.length + 1 };
          }),
        getReadModel: () =>
          Effect.sync(
            () =>
              readModels[
                Math.min(readModelIndex++, readModels.length - 1)
              ] as OrchestrationReadModel,
          ),
      },
      serverSettings: {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          defaultChatCwd,
        }),
      },
      threadShellRunner: {
        run: ({ cwd, onOutputChunk }) =>
          Effect.sync(() => {
            onOutputChunk?.(cwd);
            return {
              output: cwd,
              exitCode: 0,
            };
          }),
        closeThread: () => Effect.void,
      },
      serverCommandId: (tag) => CommandId.makeUnsafe(`server:${tag}`),
      toDispatchCommandError: (cause, fallbackMessage) =>
        new OrchestrationDispatchCommandError({
          message: fallbackMessage,
          cause,
        }),
    });

    await Effect.runPromise(
      dispatchShellCommand({
        type: "thread.shell.run",
        commandId: CommandId.makeUnsafe("cmd-shell-bootstrap"),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("msg-shell-bootstrap"),
          role: "user",
          text: "!pwd",
          attachments: [],
        },
        shellCommand: "pwd",
        bootstrap: {
          createThread: {
            projectId: ProjectId.makeUnsafe("project-shell-dispatch"),
            title: "Bootstrap Shell Thread",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: new Date().toISOString(),
          },
        },
        createdAt: new Date().toISOString(),
      }),
    );

    expect(readModelIndex).toBeGreaterThanOrEqual(2);
    await waitFor(() =>
      dispatchedCommands.some((command) => command.type === "thread.message.assistant.complete"),
    );
    const output = dispatchedCommands
      .filter(
        (
          command,
        ): command is Extract<OrchestrationCommand, { type: "thread.message.assistant.delta" }> =>
          command.type === "thread.message.assistant.delta",
      )
      .map((command) => command.delta)
      .join("");
    expect(output).toContain("$ pwd");
    expect(output).toContain(defaultChatCwd);
    const outputCommand = dispatchedCommands.find(
      (
        command,
      ): command is Extract<OrchestrationCommand, { type: "thread.message.assistant.delta" }> =>
        command.type === "thread.message.assistant.delta",
    );
    expect(outputCommand?.delta).toContain("$ pwd");
  });

  it("promotes high-volume shell output into bounded live-tail replacement updates", async () => {
    const defaultChatCwd = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-shell-tail-"));
    tempDirs.add(defaultChatCwd);
    const threadId = ThreadId.makeUnsafe("thread-shell-tail");
    const dispatchedCommands: OrchestrationCommand[] = [];
    const logBurst = Array.from({ length: 360 }, (_, index) => `line-${index + 1}`).join("\n");

    const dispatchShellCommand = makeDispatchShellCommand({
      enqueueCommand: (effect) => effect,
      dispatchInitialShellCommand: () => Effect.succeed({ sequence: 1 }),
      orchestrationEngine: {
        dispatch: (command) =>
          Effect.sync(() => {
            dispatchedCommands.push(command);
            return { sequence: dispatchedCommands.length + 1 };
          }),
        getReadModel: () => Effect.succeed(makeReadModel(threadId, defaultChatCwd)),
      },
      serverSettings: {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          defaultChatCwd,
        }),
      },
      threadShellRunner: {
        run: ({ threadId: _threadId, cwd: _cwd, command: _command, onOutputChunk }) =>
          Effect.sync(() => {
            onOutputChunk?.(logBurst);
            return {
              output: "",
              exitCode: 0,
            };
          }),
        closeThread: () => Effect.void,
      },
      serverCommandId: (tag) => CommandId.makeUnsafe(`server:${tag}`),
      toDispatchCommandError: (cause, fallbackMessage) =>
        new OrchestrationDispatchCommandError({
          message: fallbackMessage,
          cause,
        }),
    });

    await Effect.runPromise(
      dispatchShellCommand({
        type: "thread.shell.run",
        commandId: CommandId.makeUnsafe("cmd-shell-tail"),
        threadId,
        message: {
          messageId: MessageId.makeUnsafe("msg-shell-tail"),
          role: "user",
          text: "!logs",
          attachments: [],
        },
        shellCommand: "logs",
        createdAt: new Date().toISOString(),
      }),
    );

    await waitFor(() =>
      dispatchedCommands.some((command) => command.type === "thread.message.assistant.replace"),
    );

    const replacement = dispatchedCommands.find(
      (
        command,
      ): command is Extract<OrchestrationCommand, { type: "thread.message.assistant.replace" }> =>
        command.type === "thread.message.assistant.replace",
    );

    expect(replacement?.text).toContain("[live tail mode: showing latest output only]");
    expect(replacement?.text).not.toContain("\nline-1\n");
    expect(replacement?.text).toContain("line-360");
  });

  it("rejects remote execution targets before running a local shell command", async () => {
    const threadId = ThreadId.makeUnsafe("thread-shell-remote");
    let shellRunCalled = false;

    const dispatchShellCommand = makeDispatchShellCommand({
      enqueueCommand: (effect) => effect,
      dispatchInitialShellCommand: () => Effect.succeed({ sequence: 1 }),
      orchestrationEngine: {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        getReadModel: () =>
          Effect.succeed({
            ...makeReadModel(threadId, "~/workspace/bigbud"),
            projects: [
              {
                ...makeReadModel(threadId, "~/workspace/bigbud").projects[0]!,
                providerRuntimeExecutionTargetId: "local",
                workspaceExecutionTargetId: "ssh:devbox",
                executionTargetId: "local",
              },
            ],
            threads: [
              {
                ...makeReadModel(threadId, "~/workspace/bigbud").threads[0]!,
                providerRuntimeExecutionTargetId: "local",
                workspaceExecutionTargetId: "ssh:devbox",
                executionTargetId: "local",
              },
            ],
          } satisfies OrchestrationReadModel),
      },
      serverSettings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      },
      threadShellRunner: {
        run: () =>
          Effect.sync(() => {
            shellRunCalled = true;
            return {
              output: "",
              exitCode: 0,
            };
          }),
        closeThread: () => Effect.void,
      },
      serverCommandId: (tag) => CommandId.makeUnsafe(`server:${tag}`),
      toDispatchCommandError: (cause, fallbackMessage) =>
        new OrchestrationDispatchCommandError({
          message: fallbackMessage,
          cause,
        }),
    });

    await expect(
      Effect.runPromise(
        dispatchShellCommand({
          type: "thread.shell.run",
          commandId: CommandId.makeUnsafe("cmd-shell-remote"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("msg-shell-remote"),
            role: "user",
            text: "!pwd",
            attachments: [],
          },
          shellCommand: "pwd",
          createdAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toThrow("Shell commands is not implemented for execution target 'ssh:devbox' yet.");

    expect(shellRunCalled).toBe(false);
  });
});
