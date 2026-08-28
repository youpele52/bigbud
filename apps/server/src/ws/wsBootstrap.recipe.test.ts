import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationBootstrapRecipeRepositoryShape } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";

const noBranches = () =>
  Effect.succeed({
    branches: [],
    isRepo: true,
    hasOriginRemote: false,
    nextCursor: null,
    totalCount: 0,
  });

const withoutBootstrapLock = <A, E, R>(_id: string, effect: Effect.Effect<A, E, R>) => effect;

function makeRecipeRepository(): OrchestrationBootstrapRecipeRepositoryShape {
  const recipes = new Map<
    string,
    Parameters<OrchestrationBootstrapRecipeRepositoryShape["claimOrInspect"]>[0]
  >();
  return {
    claimOrInspect: (recipe) => {
      const existing = recipes.get(recipe.parentCommandId);
      if (existing) {
        const same = JSON.stringify(existing) === JSON.stringify(recipe);
        return Effect.succeed({ status: same ? "existing" : "conflict", recipe: existing });
      }
      recipes.set(recipe.parentCommandId, recipe);
      return Effect.succeed({ status: "claimed", recipe });
    },
    getByParentCommandId: (parentCommandId) =>
      Effect.succeed(
        recipes.has(parentCommandId) ? Option.some(recipes.get(parentCommandId)!) : Option.none(),
      ),
  };
}

const baseCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.makeUnsafe("cmd-bootstrap-recipe-parent"),
  threadId: ThreadId.makeUnsafe("thread-bootstrap-recipe"),
  message: {
    messageId: MessageId.makeUnsafe("msg-bootstrap-recipe"),
    role: "user" as const,
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required" as const,
  createdAt: "2026-08-27T00:00:00.000Z",
  bootstrap: {
    createThread: {
      projectId: ProjectId.makeUnsafe("project-bootstrap-recipe"),
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
    },
  },
};

describe("dispatchBootstrapThreadCommand recipes", () => {
  it("persists a command-owned recipe before Git work", async () => {
    const repository = makeRecipeRepository();
    const createWorktree = vi.fn(() =>
      Effect.succeed({ worktree: { branch: "main", path: "/worktrees/owned" } } as never),
    );
    const dispatch = makeDispatchBootstrapThreadCommand(
      {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        getReadModel: () => Effect.succeed({ projects: [], threads: [] } as never),
        getCommandOutcome: (commandId) => Effect.succeed({ commandId, status: "unknown" } as never),
      },
      { createWorktree, listBranches: noBranches },
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      withoutBootstrapLock,
      () => ({
        path: "/worktrees/owned",
        canonicalizePath: () => Effect.succeed("/worktrees/owned"),
      }),
      repository,
    );

    await Effect.runPromise(dispatch(baseCommand));

    expect(createWorktree).toHaveBeenCalledTimes(1);
    await expect(
      Effect.runPromise(repository.getByParentCommandId(baseCommand.commandId)),
    ).resolves.toMatchObject({ _tag: "Some" });
  });

  it("rejects changed recipe input before a second Git operation", async () => {
    const repository = makeRecipeRepository();
    const createWorktree = vi.fn(() =>
      Effect.succeed({ worktree: { branch: "main", path: "/worktrees/owned" } } as never),
    );
    const dispatch = makeDispatchBootstrapThreadCommand(
      {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        getReadModel: () => Effect.succeed({ projects: [], threads: [] } as never),
        getCommandOutcome: (commandId) => Effect.succeed({ commandId, status: "unknown" } as never),
      },
      { createWorktree, listBranches: noBranches },
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      withoutBootstrapLock,
      () => ({
        path: "/worktrees/owned",
        canonicalizePath: () => Effect.succeed("/worktrees/owned"),
      }),
      repository,
    );

    await Effect.runPromise(dispatch(baseCommand));
    await expect(
      Effect.runPromise(
        dispatch({
          ...baseCommand,
          bootstrap: {
            ...baseCommand.bootstrap,
            prepareWorktree: { ...baseCommand.bootstrap.prepareWorktree, baseBranch: "changed" },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "command_id_conflict" });
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("persists remote execution-target recipe identity before remote Git work", async () => {
    const repository = makeRecipeRepository();
    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: { branch: "feature/remote", path: "/remote/worktrees/owned" },
      } as never),
    );
    const dispatch = makeDispatchBootstrapThreadCommand(
      {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        getReadModel: () =>
          Effect.succeed({
            projects: [
              {
                id: baseCommand.bootstrap.createThread.projectId,
                workspaceRoot: "/repo/project",
                workspaceExecutionTargetId: "ssh:host=devbox&user=you",
              },
            ],
            threads: [],
          } as never),
        getCommandOutcome: (commandId) => Effect.succeed({ commandId, status: "unknown" } as never),
      },
      { createWorktree, listBranches: noBranches },
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      withoutBootstrapLock,
      () => null,
      repository,
    );
    const remoteCommand = {
      ...baseCommand,
      bootstrap: {
        ...baseCommand.bootstrap,
        createThread: {
          ...baseCommand.bootstrap.createThread,
          workspaceExecutionTargetId: "ssh:host=devbox&user=you",
        },
        prepareWorktree: {
          ...baseCommand.bootstrap.prepareWorktree,
          branch: "feature/remote",
        },
      },
    };

    await Effect.runPromise(dispatch(remoteCommand));
    const recipe = await Effect.runPromise(repository.getByParentCommandId(baseCommand.commandId));

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTargetId: "ssh:host=devbox&user=you",
        newBranch: "feature/remote",
      }),
    );
    expect(Option.getOrThrow(recipe)).toMatchObject({
      executionTargetId: "ssh:host=devbox&user=you",
      requestedBranch: "feature/remote",
    });
  });

  it("rejects changed remote recipe input before a second remote Git operation", async () => {
    const repository = makeRecipeRepository();
    const createWorktree = vi.fn(() =>
      Effect.succeed({
        worktree: { branch: "feature/remote", path: "/remote/worktrees/owned" },
      } as never),
    );
    const dispatch = makeDispatchBootstrapThreadCommand(
      {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        getReadModel: () =>
          Effect.succeed({
            projects: [
              {
                id: baseCommand.bootstrap.createThread.projectId,
                workspaceRoot: "/repo/project",
                workspaceExecutionTargetId: "ssh:host=devbox&user=you",
              },
            ],
            threads: [],
          } as never),
        getCommandOutcome: (commandId) => Effect.succeed({ commandId, status: "unknown" } as never),
      },
      { createWorktree, listBranches: noBranches },
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      withoutBootstrapLock,
      () => null,
      repository,
    );
    const remoteCommand = {
      ...baseCommand,
      bootstrap: {
        ...baseCommand.bootstrap,
        createThread: {
          ...baseCommand.bootstrap.createThread,
          workspaceExecutionTargetId: "ssh:host=devbox&user=you",
        },
        prepareWorktree: {
          ...baseCommand.bootstrap.prepareWorktree,
          branch: "feature/remote",
        },
      },
    };

    await Effect.runPromise(dispatch(remoteCommand));
    await expect(
      Effect.runPromise(
        dispatch({
          ...remoteCommand,
          bootstrap: {
            ...remoteCommand.bootstrap,
            prepareWorktree: {
              ...remoteCommand.bootstrap.prepareWorktree,
              branch: "feature/changed",
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "command_id_conflict" });
    expect(createWorktree).toHaveBeenCalledTimes(1);
  });

  it("does not run Git without a deterministic branch or worktree identity", async () => {
    const createWorktree = vi.fn(() =>
      Effect.succeed({ worktree: { branch: "main", path: "/worktrees/owned" } } as never),
    );
    const dispatch = makeDispatchBootstrapThreadCommand(
      {
        dispatch: () => Effect.succeed({ sequence: 1 }),
        getReadModel: () => Effect.succeed({ projects: [], threads: [] } as never),
        getCommandOutcome: (commandId) => Effect.succeed({ commandId, status: "unknown" } as never),
      },
      { createWorktree, listBranches: noBranches },
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      withoutBootstrapLock,
      () => null,
      makeRecipeRepository(),
    );

    await expect(Effect.runPromise(dispatch(baseCommand))).rejects.toThrow(
      "lacks deterministic physical identity",
    );
    expect(createWorktree).not.toHaveBeenCalled();
  });
});
