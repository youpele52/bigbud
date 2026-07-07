import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Deferred, Effect, Fiber, Option } from "effect";
import { describe, expect, it } from "vitest";

import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";

describe("dispatchBootstrapThreadCommand", () => {
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
      },
      {
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
      (tag) => CommandId.makeUnsafe(tag),
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
