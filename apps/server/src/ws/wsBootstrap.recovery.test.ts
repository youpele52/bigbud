import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  type GetCommandOutcomeResult,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";

const parentCommandId = CommandId.makeUnsafe("cmd-bootstrap-physical-recovery");
const threadId = ThreadId.makeUnsafe("thread-bootstrap-physical-recovery");
const projectId = ProjectId.makeUnsafe("project-bootstrap-physical-recovery");
const branch = "bigbud/bootstrap-physical-recovery";
const worktreePath = "/repo/worktrees/bootstrap-physical-recovery";

const childCommandId = (tag: string) => CommandId.makeUnsafe(`server:${parentCommandId}:${tag}`);

const command = {
  type: "thread.turn.start" as const,
  commandId: parentCommandId,
  threadId,
  message: {
    messageId: MessageId.makeUnsafe("msg-bootstrap-physical-recovery"),
    role: "user" as const,
    text: "resume",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required" as const,
  createdAt: "2026-08-27T00:00:00.000Z",
  bootstrap: {
    createThread: {
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
      runtimeMode: "approval-required" as const,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: "2026-08-27T00:00:00.000Z",
    },
    prepareWorktree: {
      projectCwd: "/repo/project",
      baseBranch: "main",
      branch,
    },
  },
};

describe("dispatchBootstrapThreadCommand recovery", () => {
  it("adopts the exact physical worktree after restart when metadata was not committed", async () => {
    const createId = childCommandId("bootstrap-thread-create");
    const metaId = childCommandId("bootstrap-thread-meta-update");
    const outcomes = new Map<CommandId, GetCommandOutcomeResult>([
      [
        createId,
        {
          commandId: createId,
          status: "accepted",
          aggregateKind: "thread",
          aggregateId: threadId,
          resultSequence: 1,
          acceptedAt: "2026-08-27T00:00:00.000Z",
          serverEpoch: "before-restart",
          canonicalRevision: 1,
        },
      ],
    ]);
    const createWorktree = vi.fn(() => Effect.die("duplicate physical worktree"));
    const dispatched: string[] = [];
    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      {
        dispatch: (nextCommand) => {
          dispatched.push(nextCommand.type);
          const sequence = nextCommand.type === "thread.meta.update" ? 2 : 3;
          outcomes.set(nextCommand.commandId, {
            commandId: nextCommand.commandId,
            status: "accepted",
            aggregateKind: "thread",
            aggregateId: threadId,
            resultSequence: sequence,
            acceptedAt: "2026-08-27T00:00:01.000Z",
            serverEpoch: "after-restart",
            canonicalRevision: sequence,
          });
          return Effect.succeed({ sequence });
        },
        getCommandOutcome: (commandId) =>
          Effect.succeed(
            outcomes.get(commandId) ?? {
              commandId,
              status: "unknown" as const,
              serverEpoch: "after-restart",
              canonicalRevision: 1,
            },
          ),
        getReadModel: () =>
          Effect.succeed({
            projects: [
              {
                id: projectId,
                workspaceRoot: "/repo/project",
                workspaceExecutionTargetId: null,
              },
            ],
            threads: [{ id: threadId, projectId, branch: null, worktreePath: null }],
          } as never),
      },
      {
        createWorktree,
        listBranches: () =>
          Effect.succeed({
            branches: [
              {
                name: branch,
                current: false,
                isDefault: false,
                worktreePath,
              },
            ],
            isRepo: true,
            hasOriginRemote: false,
            nextCursor: null,
            totalCount: 1,
          }),
      } as never,
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      (_id, effect) => effect,
    );

    await expect(Effect.runPromise(dispatchBootstrapThreadCommand(command))).resolves.toEqual({
      sequence: 3,
    });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatched).toEqual(["thread.meta.update", "thread.turn.start"]);
    expect(outcomes.get(metaId)).toMatchObject({ status: "accepted", aggregateId: threadId });
  });

  it("fails closed when an accepted child receipt belongs to another thread", async () => {
    const createId = childCommandId("bootstrap-thread-create");
    const dispatch = vi.fn(() => Effect.die("must not dispatch"));
    const createWorktree = vi.fn(() => Effect.die("must not create"));
    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      {
        dispatch,
        getCommandOutcome: (commandId) =>
          Effect.succeed(
            commandId === createId
              ? {
                  commandId,
                  status: "accepted" as const,
                  aggregateKind: "thread" as const,
                  aggregateId: ThreadId.makeUnsafe("another-thread"),
                  resultSequence: 1,
                  acceptedAt: "2026-08-27T00:00:00.000Z",
                  serverEpoch: "test",
                  canonicalRevision: 1,
                }
              : {
                  commandId,
                  status: "unknown" as const,
                  serverEpoch: "test",
                  canonicalRevision: 1,
                },
          ),
        getReadModel: () => Effect.die("must not read"),
      },
      {
        createWorktree,
        listBranches: () => Effect.die("must not inspect"),
      },
      { runForThread: () => Effect.die("must not run") },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      (_id, effect) => effect,
    );

    await expect(Effect.runPromise(dispatchBootstrapThreadCommand(command))).rejects.toThrow(
      "Accepted thread-create child receipt belongs to thread:another-thread",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
  });
});
