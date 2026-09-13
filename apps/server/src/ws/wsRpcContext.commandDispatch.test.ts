import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { CommandGatewayRequestContext } from "../command-gateway/Services/CommandGateway.ts";
import { makeWsRpcCommandDispatch } from "./wsRpcContext.commandDispatch.ts";
import type { OrchestrationBootstrapRecipe } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";

const command = {
  type: "project.create" as const,
  commandId: CommandId.makeUnsafe("cmd-rpc-gateway"),
  projectId: ProjectId.makeUnsafe("project-rpc-gateway"),
  title: "RPC gateway",
  workspaceRoot: null,
  defaultModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  createdAt: "2026-08-27T00:00:00.000Z",
} satisfies OrchestrationCommand;

function makeDispatch(startupGate: Effect.Effect<void> = Effect.void) {
  const contexts: CommandGatewayRequestContext[] = [];
  const recipes = new Map<CommandId, OrchestrationBootstrapRecipe>();
  const gatewayDispatch = vi.fn((input: { readonly context: CommandGatewayRequestContext }) =>
    Effect.sync(() => {
      contexts.push(input.context);
      return { sequence: contexts.length };
    }),
  );
  const engineDispatch = vi.fn((_command: OrchestrationCommand) =>
    Effect.succeed({ sequence: 99 }),
  );
  return {
    contexts,
    engineDispatch,
    dispatch: makeWsRpcCommandDispatch({
      orchestrationEngine: {
        dispatch: engineDispatch,
        getCommandOutcome: (commandId) =>
          Effect.succeed({
            commandId,
            status: "unknown",
            serverEpoch: "test",
            canonicalRevision: 0,
          }),
        getReadModel: () => Effect.succeed({ projects: [], threads: [] } as never),
        readEvents: () => Stream.empty,
        readReplay: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
      },
      commandGateway: { dispatchNormalized: gatewayDispatch },
      startup: {
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: (effect) => startupGate.pipe(Effect.andThen(effect)),
      },
      git: {
        createWorktree: () => Effect.die("unused"),
        listBranches: () => Effect.die("unused"),
      },
      projectSetupScriptRunner: { runForThread: () => Effect.die("unused") },
      refreshGitStatus: () => Effect.void,
      withBootstrapCommandLock: (_id, effect) => effect,
      resolveBootstrapWorktreeIdentity: () => null,
      bootstrapRecipes: {
        claimOrInspect: (recipe) =>
          Effect.sync(() => {
            recipes.set(recipe.parentCommandId, recipe);
            return { status: "claimed" as const, recipe };
          }),
        getByParentCommandId: (id) => Effect.succeed(Option.fromNullishOr(recipes.get(id))),
      },
    }),
  };
}

describe("ws RPC command dispatch", () => {
  it("materializes bootstrap submissions before passing delivery to the server", async () => {
    const run = makeDispatch();
    const submission = {
      type: "thread.message.submit",
      commandId: CommandId.makeUnsafe("submit-bootstrap"),
      threadId: ThreadId.makeUnsafe("new-thread"),
      message: { messageId: MessageId.makeUnsafe("message"), text: "hello" },
      delivery: "auto",
      createdAt: command.createdAt,
      bootstrap: {
        createThread: {
          projectId: command.projectId,
          title: "Thread",
          modelSelection: command.defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: command.createdAt,
        },
      },
    } satisfies OrchestrationCommand;
    const blocked = makeDispatch(Effect.die(new Error("startup not ready")));
    await expect(
      Effect.runPromise(blocked.dispatch.dispatchNormalizedCommand(submission)),
    ).rejects.toThrow("startup not ready");
    expect(blocked.engineDispatch).not.toHaveBeenCalled();
    await Effect.runPromise(run.dispatch.dispatchNormalizedCommand(submission));
    expect(run.engineDispatch.mock.calls.map(([value]) => value.type)).toEqual([
      "thread.create",
      "thread.message.submit",
    ]);
    expect(run.engineDispatch.mock.calls.at(-1)?.[0]).not.toHaveProperty("bootstrap");
    const { bootstrap: _bootstrap, ...withoutBootstrap } = submission;
    await expect(
      Effect.runPromise(run.dispatch.dispatchNormalizedCommand(withoutBootstrap)),
    ).rejects.toMatchObject({ code: "command_id_conflict" });
    expect(run.contexts).toEqual([]);
  });

  it("routes public normalized commands through the required gateway", async () => {
    const run = makeDispatch();

    await expect(
      Effect.runPromise(run.dispatch.dispatchNormalizedCommand(command)),
    ).resolves.toEqual({ sequence: 1 });
    await expect(
      Effect.runPromise(run.dispatch.dispatchNormalizedCommand(command, "mobile")),
    ).resolves.toEqual({ sequence: 2 });
    await expect(
      Effect.runPromise(run.dispatch.dispatchNormalizedCommand(command, "automation")),
    ).resolves.toEqual({ sequence: 3 });

    expect(run.contexts).toEqual([
      {
        actor: "authenticated-user",
        source: "desktop",
        authorizationScope: "authenticated-session",
      },
      {
        actor: "authenticated-user",
        source: "mobile",
        authorizationScope: "authenticated-session",
      },
      {
        actor: "authenticated-user",
        source: "automation",
        authorizationScope: "authenticated-session",
      },
    ]);
    expect(run.engineDispatch).not.toHaveBeenCalled();
  });

  it("routes non-bootstrap shell command admission through internal gateway context", async () => {
    const run = makeDispatch();
    await expect(
      Effect.runPromise(
        run.dispatch.dispatchInitialShellCommand({
          type: "thread.shell.run",
          commandId: CommandId.makeUnsafe("cmd-shell-rpc-gateway"),
          threadId: "thread-shell-rpc-gateway" as never,
          message: {
            messageId: "message-shell-rpc-gateway" as never,
            role: "user",
            text: "pwd",
            attachments: [],
          },
          shellCommand: "pwd",
          createdAt: "2026-08-27T00:00:00.000Z",
        }),
      ),
    ).resolves.toEqual({ sequence: 1 });

    expect(run.contexts).toEqual([
      { actor: "server", source: "internal", authorizationScope: "internal" },
    ]);
    expect(run.engineDispatch).not.toHaveBeenCalled();
  });
});
