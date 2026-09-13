import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { GetCommandOutcomeResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { calculateCommandPayloadDigest } from "../orchestration/commandDigest.ts";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";

const command = {
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("submit-bootstrap"),
  threadId: ThreadId.makeUnsafe("submit-thread"),
  message: { messageId: MessageId.makeUnsafe("submit-message"), text: "hello" },
  delivery: "auto",
  createdAt: "2026-09-11T00:00:00.000Z",
  bootstrap: {
    createThread: {
      projectId: ProjectId.makeUnsafe("project"),
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-09-11T00:00:00.000Z",
    },
    prepareWorktree: { projectCwd: "/repo", baseBranch: "main", branch: "feature/submission" },
  },
} satisfies OrchestrationCommand;

function fixture(busy = false) {
  const receipts = new Map<CommandId, { digest: string; outcome: GetCommandOutcomeResult }>();
  let sequence = 0;
  let loseFinalAcknowledgment = false;
  let stopBefore: OrchestrationCommand["type"] | undefined;
  const dispatch = vi.fn((next: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (next.type === stopBefore) {
        stopBefore = undefined;
        return yield* Effect.fail(new Error("stopped before durable boundary"));
      }
      const digest = calculateCommandPayloadDigest(next).digest;
      const existing = receipts.get(next.commandId);
      if (existing) {
        if (existing.digest !== digest) return yield* Effect.fail(new Error("command_id_conflict"));
        return {
          sequence: existing.outcome.status === "accepted" ? existing.outcome.resultSequence : 0,
        };
      }
      sequence += 1;
      receipts.set(next.commandId, {
        digest,
        outcome: {
          commandId: next.commandId,
          status: "accepted",
          aggregateKind: "thread",
          aggregateId: command.threadId,
          resultSequence: sequence,
          acceptedAt: command.createdAt,
          serverEpoch: "test",
          canonicalRevision: sequence,
        },
      });
      if (next.type === "thread.message.submit" && loseFinalAcknowledgment) {
        loseFinalAcknowledgment = false;
        return yield* Effect.fail(new Error("lost final acknowledgment"));
      }
      return { sequence };
    }),
  );
  let physicalWorktreeExists = false;
  const createWorktree = vi.fn(() =>
    Effect.sync(() => {
      physicalWorktreeExists = true;
      return { worktree: { branch: "feature/submission", path: "/worktree" } } as never;
    }),
  );
  const recipes = new Map<string, unknown>();
  const build = () =>
    makeDispatchBootstrapThreadCommand(
      {
        dispatch: dispatch as never,
        getCommandOutcome: (id) =>
          Effect.succeed(
            receipts.get(id)?.outcome ?? {
              commandId: id,
              status: "unknown",
              serverEpoch: "test",
              canonicalRevision: sequence,
            },
          ),
        getReadModel: () =>
          Effect.succeed({
            projects: [{ id: command.bootstrap.createThread.projectId, workspaceRoot: "/repo" }],
            threads: [
              {
                id: command.threadId,
                projectId: command.bootstrap.createThread.projectId,
                worktreePath: "/worktree",
                activities: [],
                messages: [],
                proposedPlans: [],
                session: busy ? { status: "running" } : null,
              },
            ],
          } as never),
      },
      {
        createWorktree,
        listBranches: () =>
          Effect.succeed({
            branches: physicalWorktreeExists
              ? [
                  {
                    name: "feature/submission",
                    current: false,
                    isDefault: false,
                    worktreePath: "/worktree",
                  },
                ]
              : [],
            isRepo: true,
            hasOriginRemote: false,
            nextCursor: null,
            totalCount: 0,
          }),
      },
      { runForThread: () => Effect.succeed({ status: "no-script" }) },
      () => Effect.void,
      () => Effect.succeed({ sequence: 0 }),
      (id, tag) => CommandId.makeUnsafe(`server:${id}:${tag}`),
      (_id, effect) => effect,
      () => null,
      {
        claimOrInspect: (recipe) => {
          const previous = recipes.get(recipe.parentCommandId);
          recipes.set(recipe.parentCommandId, previous ?? recipe);
          return Effect.succeed({
            status: previous
              ? JSON.stringify(previous) === JSON.stringify(recipe)
                ? "existing"
                : "conflict"
              : "claimed",
            recipe: (previous ?? recipe) as typeof recipe,
          });
        },
        getByParentCommandId: (id) =>
          Effect.succeed(Option.fromNullishOr(recipes.get(id)) as never),
      },
    );
  return {
    dispatch,
    createWorktree,
    receipts,
    build,
    stopBefore: (type: OrchestrationCommand["type"]) => {
      stopBefore = type;
    },
    loseAck: () => {
      loseFinalAcknowledgment = true;
    },
  };
}

describe("submission bootstrap safety", () => {
  it("rejects busy-thread preparation before changing its worktree", async () => {
    const run = fixture(true);
    await expect(Effect.runPromise(run.build()(command))).rejects.toThrow(/idle thread/);
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(run.createWorktree).not.toHaveBeenCalled();
  });

  it("rejects queue-only preparation before any child dispatch or physical work", async () => {
    const run = fixture();
    await expect(Effect.runPromise(run.build()({ ...command, delivery: "queue" }))).rejects.toThrow(
      /queue/i,
    );
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(run.createWorktree).not.toHaveBeenCalled();
  });

  it("replays a lost final acknowledgment without preparing twice or converting submit to start", async () => {
    const run = fixture();
    run.loseAck();
    await expect(Effect.runPromise(run.build()(command))).rejects.toThrow(
      "lost final acknowledgment",
    );
    await expect(Effect.runPromise(run.build()(command))).resolves.toEqual({ sequence: 3 });
    expect(run.createWorktree).toHaveBeenCalledTimes(1);
    expect(run.dispatch.mock.calls.map(([next]) => next.type)).toEqual([
      "thread.create",
      "thread.meta.update",
      "thread.message.submit",
      "thread.message.submit",
    ]);
  });

  it.each(["thread.create", "thread.meta.update", "thread.message.submit"] as const)(
    "recovers a stop before %s with the same owned physical worktree",
    async (stage) => {
      const run = fixture();
      run.stopBefore(stage);
      await expect(Effect.runPromise(run.build()(command))).rejects.toThrow(
        "stopped before durable boundary",
      );
      await expect(Effect.runPromise(run.build()(command))).resolves.toEqual({ sequence: 3 });
      expect(run.createWorktree).toHaveBeenCalledTimes(1);
      expect(run.receipts.size).toBe(3);
    },
  );

  it("protects create-only bootstrap identity without a physical recipe", async () => {
    const run = fixture();
    const createOnly = { ...command, bootstrap: { createThread: command.bootstrap.createThread } };
    await Effect.runPromise(run.build()(createOnly));
    await expect(Effect.runPromise(run.build()(createOnly))).resolves.toEqual({ sequence: 2 });
    await expect(
      Effect.runPromise(
        run.build()({
          ...createOnly,
          bootstrap: {
            createThread: { ...createOnly.bootstrap.createThread, title: "different" },
          },
        }),
      ),
    ).rejects.toThrow(/conflict/);
    expect(run.createWorktree).not.toHaveBeenCalled();
  });

  it.each(["title", "setup", "worktree"] as const)(
    "rejects changed %s bootstrap after parent acceptance",
    async (field) => {
      const run = fixture();
      await Effect.runPromise(run.build()(command));
      const bootstrap = {
        ...command.bootstrap,
        ...(field === "title"
          ? { createThread: { ...command.bootstrap.createThread, title: "changed" } }
          : {}),
        ...(field === "setup" ? { runSetupScript: true } : {}),
        ...(field === "worktree"
          ? { prepareWorktree: { ...command.bootstrap.prepareWorktree, branch: "changed" } }
          : {}),
      };
      await expect(Effect.runPromise(run.build()({ ...command, bootstrap }))).rejects.toThrow(
        /conflict/i,
      );
      expect(run.createWorktree).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a final receipt owned by another thread before shortcut dispatch", async () => {
    const run = fixture();
    run.receipts.set(command.commandId, {
      digest: "wrong",
      outcome: {
        commandId: command.commandId,
        status: "accepted",
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("other"),
        resultSequence: 1,
        acceptedAt: command.createdAt,
        serverEpoch: "test",
        canonicalRevision: 1,
      },
    });
    await expect(Effect.runPromise(run.build()(command))).rejects.toThrow(/receipt belongs/);
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(run.createWorktree).not.toHaveBeenCalled();
  });
});
