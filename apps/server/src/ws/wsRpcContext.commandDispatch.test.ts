import { CommandId, ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { CommandGatewayRequestContext } from "../command-gateway/Services/CommandGateway.ts";
import { makeWsRpcCommandDispatch } from "./wsRpcContext.commandDispatch.ts";

const command = {
  type: "project.create" as const,
  commandId: CommandId.makeUnsafe("cmd-rpc-gateway"),
  projectId: ProjectId.makeUnsafe("project-rpc-gateway"),
  title: "RPC gateway",
  workspaceRoot: null,
  defaultModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  createdAt: "2026-08-27T00:00:00.000Z",
} satisfies OrchestrationCommand;

function makeDispatch() {
  const contexts: CommandGatewayRequestContext[] = [];
  const gatewayDispatch = vi.fn((input: { readonly context: CommandGatewayRequestContext }) =>
    Effect.sync(() => {
      contexts.push(input.context);
      return { sequence: contexts.length };
    }),
  );
  const engineDispatch = vi.fn(() => Effect.succeed({ sequence: 99 }));
  return {
    contexts,
    engineDispatch,
    dispatch: makeWsRpcCommandDispatch({
      orchestrationEngine: {
        dispatch: engineDispatch,
        getReadModel: () => Effect.succeed({ projects: [], threads: [] } as never),
        readEvents: () => Stream.empty,
        readReplay: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
      },
      commandGateway: { dispatchNormalized: gatewayDispatch },
      startup: {
        awaitCommandReady: Effect.void,
        markHttpListening: Effect.void,
        enqueueCommand: (effect) => effect,
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
        claimOrInspect: () => Effect.die("unused"),
        getByParentCommandId: () => Effect.succeed(Option.none()),
      },
    }),
  };
}

describe("ws RPC command dispatch", () => {
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
