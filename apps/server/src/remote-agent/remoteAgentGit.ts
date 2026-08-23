import { createHash, randomUUID } from "node:crypto";

import { Effect, Layer, ServiceMap } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../git/Services/GitCore.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

export interface RemoteAgentGitExecuteInput {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly operation: string;
  readonly operationId?: string;
  readonly stdin?: string;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface RemoteAgentGitClientResolver {
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentProcessClient>;
}

export type RemoteAgentGitExecutor = (
  input: ExecuteGitInput,
) => Effect.Effect<ExecuteGitResult, GitCommandError>;

export class RemoteAgentGitExecutorService extends ServiceMap.Service<
  RemoteAgentGitExecutorService,
  RemoteAgentGitExecutor
>()("bigbud/remote-agent/RemoteAgentGitExecutor") {}

function operationId(input: RemoteAgentGitExecuteInput): string {
  return input.operationId ?? `git-${randomUUID()}`;
}

function requestDigest(input: RemoteAgentGitExecuteInput): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(input));
}

function workspaceHandle(input: RemoteAgentGitExecuteInput): string {
  return `workspace-${createHash("sha256")
    .update(`${input.executionTargetId}\u0000${input.cwd}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function asError(input: RemoteAgentGitExecuteInput, cause: unknown): GitCommandError {
  return new GitCommandError({
    operation: input.operation,
    command: `git ${input.args.join(" ")}`,
    cwd: input.cwd,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export function makeRemoteAgentGitExecutor(resolver: RemoteAgentGitClientResolver) {
  return (input: RemoteAgentGitExecuteInput) =>
    Effect.tryPromise({
      try: async () => {
        const client = await resolver.resolve(input.executionTargetId);
        await new RemoteAgentWorkspaceClient(client.connection).openWorkspace(
          workspaceHandle(input),
          input.cwd,
        );
        const result = await client.run({
          workspaceHandle: workspaceHandle(input),
          operationId: operationId(input),
          requestDigest: requestDigest(input),
          command: "git",
          args: input.args,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.stdin !== undefined ? { stdin: new TextEncoder().encode(input.stdin) } : {}),
        });
        return {
          code: result.completed.hasExitCode ? result.completed.exitCode : -1,
          stdout: new TextDecoder().decode(result.stdout),
          stderr: new TextDecoder().decode(result.stderr),
          stdoutTruncated: result.completed.outputTruncated,
          stderrTruncated: result.completed.outputTruncated,
        };
      },
      catch: (cause) => asError(input, cause),
    });
}

export function makeRemoteAgentGitCoreExecutor(
  resolver: RemoteAgentGitClientResolver,
): RemoteAgentGitExecutor {
  const execute = makeRemoteAgentGitExecutor(resolver);
  return (input) => {
    const executionTargetId = input.executionTargetId;
    if (!executionTargetId) {
      return Effect.fail(
        new GitCommandError({
          operation: input.operation,
          command: `git ${input.args.join(" ")}`,
          cwd: input.cwd,
          detail: "A remote Git execution target is required.",
        }),
      );
    }
    return execute({
      executionTargetId,
      cwd: input.cwd,
      args: input.args,
      operation: input.operation,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      environment: [{ name: "GIT_TERMINAL_PROMPT", value: "0" }],
    });
  };
}

export function makeRemoteAgentGitExecutorLayer(
  resolver: RemoteAgentGitClientResolver,
): Layer.Layer<RemoteAgentGitExecutorService> {
  return Layer.succeed(RemoteAgentGitExecutorService, makeRemoteAgentGitCoreExecutor(resolver));
}
