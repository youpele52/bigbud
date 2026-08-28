import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";

const withoutBootstrapLock = <A, E, R>(_id: string, effect: Effect.Effect<A, E, R>) => effect;
const unknownOutcome = (commandId: CommandId) =>
  Effect.succeed({
    commandId,
    status: "unknown" as const,
    serverEpoch: "test",
    canonicalRevision: 0,
  });
const noBranches = () =>
  Effect.succeed({
    branches: [],
    isRepo: true,
    hasOriginRemote: false,
    nextCursor: null,
    totalCount: 0,
  });

describe("dispatchBootstrapThreadCommand", () => {
  it("reuses the committed bootstrap child outcome when the parent retry loses its response", async () => {
    const childOutcomes = new Map<string, { readonly sequence: number }>();
    const childCommandIds: string[] = [];
    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      {
        dispatch: (command) => {
          childCommandIds.push(command.commandId);
          const existing = childOutcomes.get(command.commandId);
          if (existing) return Effect.succeed(existing);
          const outcome = { sequence: childOutcomes.size + 1 };
          childOutcomes.set(command.commandId, outcome);
          return Effect.succeed(outcome);
        },
        getReadModel: () => Effect.die("not reached"),
        getCommandOutcome: unknownOutcome,
      },
      { createWorktree: () => Effect.die("not reached"), listBranches: noBranches },
      { runForThread: () => Effect.die("not reached") },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (parentCommandId, tag) => CommandId.makeUnsafe(`server:${parentCommandId}:${tag}`),
      withoutBootstrapLock,
    );
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.makeUnsafe("cmd-bootstrap-retry"),
      threadId: ThreadId.makeUnsafe("thread-bootstrap-retry"),
      message: {
        messageId: MessageId.makeUnsafe("msg-bootstrap-retry"),
        role: "user" as const,
        text: "hello",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt: "2026-08-26T00:00:00.000Z",
      bootstrap: {
        createThread: {
          projectId: ProjectId.makeUnsafe("project-bootstrap-retry"),
          title: "Thread",
          modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
          runtimeMode: "approval-required" as const,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      },
    };

    const first = await Effect.runPromise(dispatchBootstrapThreadCommand(command));
    const retry = await Effect.runPromise(dispatchBootstrapThreadCommand(command));

    expect(retry).toEqual(first);
    expect(childCommandIds).toEqual([
      "server:cmd-bootstrap-retry:bootstrap-thread-create",
      "cmd-bootstrap-retry",
      "server:cmd-bootstrap-retry:bootstrap-thread-create",
      "cmd-bootstrap-retry",
    ]);
  });

  it("preserves a structured duplicate-create rejection", async () => {
    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      {
        dispatch: (command) =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Thread already exists and cannot be created twice.",
              code: "thread_already_exists",
            }),
          ),
        getReadModel: () => Effect.die("not reached"),
        getCommandOutcome: unknownOutcome,
      },
      { createWorktree: () => Effect.die("not reached"), listBranches: noBranches },
      { runForThread: () => Effect.die("not reached") },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (_parentCommandId, tag) => CommandId.makeUnsafe(tag),
      withoutBootstrapLock,
    );

    const error = await Effect.runPromise(
      Effect.flip(
        dispatchBootstrapThreadCommand({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("cmd-duplicate"),
          threadId: ThreadId.makeUnsafe("thread-duplicate"),
          message: {
            messageId: MessageId.makeUnsafe("msg-duplicate"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-08-26T00:00:00.000Z",
          bootstrap: {
            createThread: {
              projectId: ProjectId.makeUnsafe("project-1"),
              title: "Thread",
              modelSelection: { provider: "codex", model: "gpt-5-codex" },
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: "2026-08-26T00:00:00.000Z",
            },
          },
        }),
      ),
    );

    expect(error).toMatchObject({
      _tag: "OrchestrationDispatchCommandError",
      code: "thread_already_exists",
    });
  });

  it("resumes after committed worktree metadata without recreating or deleting", async () => {
    const parentCommandId = CommandId.makeUnsafe("cmd-bootstrap-resume");
    const threadId = ThreadId.makeUnsafe("thread-bootstrap-resume");
    const projectId = ProjectId.makeUnsafe("project-bootstrap-resume");
    const createCommandId = CommandId.makeUnsafe(
      "server:cmd-bootstrap-resume:bootstrap-thread-create",
    );
    const metaCommandId = CommandId.makeUnsafe(
      "server:cmd-bootstrap-resume:bootstrap-thread-meta-update",
    );
    const dispatched: string[] = [];
    let turnAttempts = 0;
    const createWorktree = vi.fn(() => Effect.die("duplicate worktree"));
    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      {
        dispatch: (command) => {
          dispatched.push(command.type);
          if (command.type !== "thread.turn.start") {
            return Effect.die(`unexpected ${command.type}`);
          }
          turnAttempts += 1;
          return turnAttempts === 1
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Injected unknown final-turn failure.",
                  code: "thread_already_exists",
                }),
              )
            : Effect.succeed({ sequence: 42 });
        },
        getCommandOutcome: (commandId) => {
          if (commandId === parentCommandId) {
            return Effect.succeed({ commandId, status: "unknown" } as never);
          }
          if (commandId === createCommandId || commandId === metaCommandId) {
            return Effect.succeed({
              commandId,
              status: "accepted",
              aggregateKind: "thread",
              aggregateId: threadId,
              resultSequence: commandId === createCommandId ? 1 : 2,
            } as never);
          }
          return Effect.succeed({ commandId, status: "unknown" } as never);
        },
        getReadModel: () =>
          Effect.succeed({
            projects: [],
            threads: [
              {
                id: threadId,
                projectId,
                branch: "bigbud/resume",
                worktreePath: "/repo/worktrees/resume",
              },
            ],
          } as never),
      },
      { createWorktree, listBranches: noBranches },
      { runForThread: () => Effect.succeed({ status: "no-script" as const }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (commandId, tag) => CommandId.makeUnsafe(`server:${commandId}:${tag}`),
      withoutBootstrapLock,
    );

    const run = () =>
      Effect.runPromise(
        dispatchBootstrapThreadCommand({
          type: "thread.turn.start",
          commandId: parentCommandId,
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("msg-bootstrap-resume"),
            role: "user",
            text: "resume",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-08-27T00:00:00.000Z",
          bootstrap: {
            createThread: {
              projectId,
              title: "Thread",
              modelSelection: { provider: "codex", model: "gpt-5-codex" },
              runtimeMode: "approval-required",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: null,
              createdAt: "2026-08-27T00:00:00.000Z",
            },
            prepareWorktree: {
              projectCwd: "/repo/project",
              baseBranch: "main",
              branch: "bigbud/resume",
            },
          },
        }),
      );

    await expect(run()).rejects.toMatchObject({
      _tag: "OrchestrationDispatchCommandError",
    });
    await expect(run()).resolves.toEqual({ sequence: 42 });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(dispatched).toEqual(["thread.turn.start", "thread.turn.start"]);
    expect(dispatched).not.toContain("thread.delete");
  });

  it("dispatches the first turn before post-bootstrap setup work completes", async () => {
    const refreshRelease = await Effect.runPromise(Deferred.make<void, never>());
    const dispatched: string[] = [];

    const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
      {
        dispatch: (command) => {
          dispatched.push(command.type);
          return Effect.succeed({ sequence: dispatched.length });
        },
        getReadModel: () =>
          Effect.succeed({
            snapshotSequence: 1,
            updatedAt: "2026-07-04T00:00:00.000Z",
            projects: [
              {
                id: ProjectId.makeUnsafe("project-1"),
                title: "Project",
                workspaceRoot: "/repo/project",
                defaultModelSelection: {
                  provider: "codex",
                  model: "gpt-5-codex",
                },
                scripts: [
                  {
                    id: "setup",
                    name: "Setup",
                    command: "bun install",
                    icon: "configure",
                    runOnWorktreeCreate: true,
                  },
                ],
                createdAt: "2026-07-04T00:00:00.000Z",
                updatedAt: "2026-07-04T00:00:00.000Z",
                deletingAt: null,
                deletedAt: null,
              },
            ],
            threads: [],
            providerSessions: [],
            providerStatuses: [],
            pendingApprovals: [],
            latestTurnByThreadId: {},
          } as never),
        getCommandOutcome: unknownOutcome,
      },
      {
        listBranches: noBranches,
        createWorktree: () =>
          Effect.succeed({
            worktree: {
              branch: "bigbud/12345678",
              path: "/repo/worktrees/thread-1",
            },
          } as never),
      },
      {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
      () => Deferred.await(refreshRelease),
      () => Effect.succeed({ sequence: 0 }),
      (_parentCommandId, tag) => CommandId.makeUnsafe(tag),
      withoutBootstrapLock,
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* dispatchBootstrapThreadCommand({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-start"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            message: {
              messageId: MessageId.makeUnsafe("msg-1"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: "2026-07-04T00:00:00.000Z",
            bootstrap: {
              createThread: {
                projectId: ProjectId.makeUnsafe("project-1"),
                title: "Thread",
                modelSelection: {
                  provider: "codex",
                  model: "gpt-5-codex",
                },
                runtimeMode: "approval-required",
                interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                branch: null,
                worktreePath: null,
                createdAt: "2026-07-04T00:00:00.000Z",
              },
              prepareWorktree: {
                projectCwd: "/repo/project",
                baseBranch: "main",
                branch: "bigbud/12345678",
              },
              runSetupScript: true,
            },
          }).pipe(Effect.forkScoped);

          yield* Effect.sleep("50 millis");

          const completed = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("10 millis"));
          expect(Option.isSome(completed)).toBe(true);
          expect(dispatched).toEqual(["thread.create", "thread.meta.update", "thread.turn.start"]);

          yield* Deferred.succeed(refreshRelease, undefined);
          yield* Fiber.join(fiber);
        }),
      ),
    );
  });
});
