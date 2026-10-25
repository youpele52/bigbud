import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { LEGACY_OPENCODE_READ_ONLY_MESSAGE } from "@bigbud/shared/providerLifecycle";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";

const threadId = ThreadId.makeUnsafe("legacy-bootstrap");
const projectId = ProjectId.makeUnsafe("legacy-project");
const now = "2026-10-10T00:00:00.000Z";
type BootstrapCommand = Extract<
  OrchestrationCommand,
  { type: "thread.turn.start" | "thread.message.submit" | "thread.shell.run" }
>;

function command(type: BootstrapCommand["type"], createLegacy = false): BootstrapCommand {
  const common = {
    commandId: CommandId.makeUnsafe(`legacy-bootstrap-${type}`),
    threadId,
    message: {
      messageId: MessageId.makeUnsafe("message"),
      role: "user" as const,
      text: "run",
      attachments: [],
    },
    createdAt: now,
    bootstrap: {
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main", branch: "feature/retired" },
      runSetupScript: true,
      ...(createLegacy
        ? {
            createThread: {
              projectId,
              title: "Retired",
              modelSelection: { provider: "opencode" as const, model: "historical" },
              runtimeMode: "approval-required" as const,
              interactionMode: "default" as const,
              branch: null,
              worktreePath: null,
              createdAt: now,
            },
          }
        : {}),
    },
  };
  if (type === "thread.shell.run") return { ...common, type, shellCommand: "echo unsafe" };
  if (type === "thread.message.submit") return { ...common, type, delivery: "auto" };
  return { ...common, type, runtimeMode: "approval-required", interactionMode: "default" };
}

function fixture(identity: "selection" | "session" | "create") {
  const history = {
    projects: [{ id: projectId, workspaceRoot: "/repo" }],
    threads:
      identity === "create"
        ? []
        : [
            {
              id: threadId,
              projectId,
              modelSelection: {
                provider: identity === "selection" ? "opencode" : "opencodeV2",
                model: "historical",
              },
              session: identity === "session" ? { providerName: "opencode" } : null,
              branch: null,
              worktreePath: null,
              messages: [{ text: "Retain this history" }],
            },
          ],
  } as unknown as OrchestrationReadModel;
  const unsafe = () => Effect.die("retired bootstrap must not cause side effects");
  const dispatch = vi.fn(unsafe);
  const createWorktree = vi.fn(unsafe);
  const listBranches = vi.fn(unsafe);
  const setup = vi.fn(unsafe);
  const refresh = vi.fn(unsafe);
  const activity = vi.fn(unsafe);
  const claimOrInspect = vi.fn(unsafe);
  const getRecipe = vi.fn(() => Effect.succeed(Option.none()));
  const run = makeDispatchBootstrapThreadCommand(
    {
      dispatch,
      getReadModel: () => Effect.succeed(history),
      getCommandOutcome: (commandId) =>
        Effect.succeed({ commandId, status: "unknown", serverEpoch: "test", canonicalRevision: 0 }),
    },
    { createWorktree, listBranches },
    { runForThread: setup },
    refresh,
    activity,
    (id, tag) => CommandId.makeUnsafe(`server:${id}:${tag}`),
    (_id, effect) => effect,
    undefined,
    { claimOrInspect, getByParentCommandId: getRecipe },
  );
  return {
    run,
    history,
    effects: [
      dispatch,
      createWorktree,
      listBranches,
      setup,
      refresh,
      activity,
      claimOrInspect,
      getRecipe,
    ],
  };
}

describe("legacy OpenCode bootstrap admission", () => {
  for (const identity of ["selection", "session", "create"] as const) {
    it.each(["thread.turn.start", "thread.message.submit", "thread.shell.run"] as const)(
      `rejects %s for legacy ${identity} before Git, recipes, metadata or setup`,
      async (type) => {
        const harness = fixture(identity);
        const before = structuredClone(harness.history);
        await expect(
          Effect.runPromise(harness.run(command(type, identity === "create"))),
        ).rejects.toMatchObject({
          _tag: "OrchestrationDispatchCommandError",
          message: LEGACY_OPENCODE_READ_ONLY_MESSAGE,
        });
        for (const effect of harness.effects) expect(effect).not.toHaveBeenCalled();
        expect(harness.history).toEqual(before);
      },
    );
  }
});
