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
    const outputCommand = dispatchedCommands.find(
      (
        command,
      ): command is Extract<OrchestrationCommand, { type: "thread.message.assistant.delta" }> =>
        command.type === "thread.message.assistant.delta",
    );
    expect(outputCommand?.delta).toContain("$ pwd");
    expect(outputCommand?.delta).toContain(defaultChatCwd);
  });
});
