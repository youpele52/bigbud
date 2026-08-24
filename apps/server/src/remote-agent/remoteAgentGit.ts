import { randomUUID } from "node:crypto";

import { Effect, Layer, ServiceMap } from "effect";

import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { ExecuteGitInput, ExecuteGitResult } from "../git/Services/GitCore.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import {
  remoteAgentProcessRequestDigest,
  remoteAgentWorkspaceHandle,
} from "./remoteAgentProcessRequest.ts";
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
  readonly truncateOutputAtMaxBytes?: boolean;
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

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const ALLOWED_GIT_ENVIRONMENT = new Set([
  "CI",
  "COLUMNS",
  "GIT_ASKPASS",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_SSH_COMMAND",
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
]);

function isAllowedGitEnvironmentName(name: string): boolean {
  return (
    ALLOWED_GIT_ENVIRONMENT.has(name) ||
    (name.startsWith("GIT_CONFIG_") &&
      (name === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)))
  );
}

function operationId(input: RemoteAgentGitExecuteInput): string {
  return input.operationId ?? `git-${randomUUID()}`;
}

function gitEnvironment(input: NodeJS.ProcessEnv | undefined) {
  return [
    { name: "GIT_TERMINAL_PROMPT", value: "0" },
    ...Object.entries(input ?? {}).flatMap(([name, value]) => {
      if (value === undefined || !isAllowedGitEnvironmentName(name)) return [];
      return [{ name, value }];
    }),
  ];
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
        const handle = remoteAgentWorkspaceHandle(input);
        const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        const environment = input.environment ?? [];
        await new RemoteAgentWorkspaceClient(client.connection).openWorkspace(handle, input.cwd);
        const digestInput = {
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          command: "git",
          args: input.args,
          environment,
          timeoutMs,
          maxOutputBytes,
          ...(input.truncateOutputAtMaxBytes !== undefined
            ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
            : {}),
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        } as const;
        const result = await client.run({
          workspaceHandle: handle,
          operationId: operationId(input),
          requestDigest: remoteAgentProcessRequestDigest(digestInput),
          command: "git",
          args: input.args,
          timeoutMs,
          maxOutputBytes,
          environment,
          ...(input.stdin !== undefined ? { stdin: new TextEncoder().encode(input.stdin) } : {}),
        });
        if (result.completed.outputTruncated && input.truncateOutputAtMaxBytes !== true) {
          throw new Error(`git ${input.args.join(" ")} exceeded the remote agent output limit.`);
        }
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
      ...(input.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
        : {}),
      environment: gitEnvironment(input.env),
    });
  };
}

export function makeRemoteAgentGitExecutorLayer(
  resolver: RemoteAgentGitClientResolver,
): Layer.Layer<RemoteAgentGitExecutorService> {
  return Layer.succeed(RemoteAgentGitExecutorService, makeRemoteAgentGitCoreExecutor(resolver));
}
