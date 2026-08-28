import { CommandId, EventId, type ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { OrchestrationDispatchCommandError } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect } from "effect";

import type { CommandAdmissionError } from "../command-admission/CommandAdmission.ts";
import type {
  CommandGatewayShape,
  CommandGatewaySource,
} from "../command-gateway/Services/CommandGateway.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationBootstrapRecipeRepositoryShape } from "../persistence/Services/OrchestrationBootstrapRecipes.ts";
import type { ProjectSetupScriptRunnerShape } from "../project/Services/ProjectSetupScriptRunner.ts";
import type {
  ServerRuntimeStartupError,
  ServerRuntimeStartupShape,
} from "../startup/serverRuntimeStartup.ts";
import { makeDispatchBootstrapThreadCommand } from "./wsBootstrap.ts";
import type { BootstrapGit } from "./wsBootstrap.worktree.ts";
import type { BootstrapCommandLock } from "./wsBootstrap.lock.ts";
import type { BootstrapWorktreeIdentity } from "./wsBootstrap.ts";
import { toDispatchCommandError } from "./wsDispatchCommandError.ts";

type PublicDispatchSource = Extract<CommandGatewaySource, "desktop" | "mobile" | "automation">;
type DispatchSource = PublicDispatchSource | "internal";

export function makeWsRpcCommandDispatch(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly commandGateway: CommandGatewayShape;
  readonly startup: ServerRuntimeStartupShape;
  readonly git: BootstrapGit;
  readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
  readonly withBootstrapCommandLock: BootstrapCommandLock;
  readonly resolveBootstrapWorktreeIdentity: (input: {
    readonly parentCommandId: CommandId;
    readonly projectCwd: string;
    readonly branch: string;
    readonly executionTargetId?: string;
  }) => BootstrapWorktreeIdentity | null;
  readonly bootstrapRecipes: OrchestrationBootstrapRecipeRepositoryShape;
}) {
  const serverCommandId = (parentOrTag: CommandId | string, tag?: string) =>
    CommandId.makeUnsafe(
      tag ? `server:${parentOrTag}:${tag}` : `server:${parentOrTag}:${crypto.randomUUID()}`,
    );

  const appendSetupScriptActivity = (activity: {
    readonly parentCommandId: CommandId;
    readonly threadId: ThreadId;
    readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
    readonly summary: string;
    readonly createdAt: string;
    readonly payload: Record<string, unknown>;
    readonly tone: "info" | "error";
  }) =>
    input.orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId(
        activity.parentCommandId,
        `setup-script-activity:${activity.kind}`,
      ),
      threadId: activity.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: activity.tone,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
        turnId: null,
        createdAt: activity.createdAt,
      },
      createdAt: activity.createdAt,
    });

  const dispatchBootstrapThreadCommand = makeDispatchBootstrapThreadCommand(
    input.orchestrationEngine,
    input.git,
    input.projectSetupScriptRunner,
    input.refreshGitStatus,
    appendSetupScriptActivity,
    serverCommandId,
    input.withBootstrapCommandLock,
    input.resolveBootstrapWorktreeIdentity,
    input.bootstrapRecipes,
  );

  const dispatchNormalizedCommand = (
    normalizedCommand: OrchestrationCommand,
    source: DispatchSource = "desktop",
  ): Effect.Effect<
    { readonly sequence: number },
    OrchestrationDispatchCommandError | ServerRuntimeStartupError | CommandAdmissionError
  > => {
    const dispatchEffect =
      normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
        ? dispatchBootstrapThreadCommand(normalizedCommand)
        : input.commandGateway.dispatchNormalized({
            command: normalizedCommand,
            context: {
              actor: source === "internal" ? "server" : "authenticated-user",
              source,
              authorizationScope: source === "internal" ? "internal" : "authenticated-session",
            },
          });

    return input.startup
      .enqueueCommand(dispatchEffect)
      .pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
        ),
      );
  };

  const dispatchInitialShellCommand = (
    normalizedCommand: Extract<OrchestrationCommand, { type: "thread.shell.run" }>,
  ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
    normalizedCommand.bootstrap !== undefined
      ? dispatchBootstrapThreadCommand(normalizedCommand)
      : input.commandGateway.dispatchNormalized({
          command: normalizedCommand,
          context: {
            actor: "server",
            source: "internal",
            authorizationScope: "internal",
          },
        });

  return {
    dispatchBootstrapThreadCommand,
    dispatchInitialShellCommand,
    dispatchNormalizedCommand,
    serverCommandId,
  };
}
