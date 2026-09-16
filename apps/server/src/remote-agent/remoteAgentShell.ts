import { createHash, randomUUID } from "node:crypto";

import { Effect, ServiceMap } from "effect";

import {
  ThreadShellRunnerError,
  type ThreadShellRunnerShape,
} from "../shell/Services/ThreadShellRunner.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import type { OwnedRemoteProcessRunner } from "./remoteAgentOwnedProcess.ts";

export interface RemoteAgentShellRunnerResolver {
  readonly resolve: (executionTargetId: string) => ThreadShellRunnerShape;
}

export class RemoteAgentShellRunner extends ServiceMap.Service<
  RemoteAgentShellRunner,
  RemoteAgentShellRunnerResolver
>()("bigbud/remote-agent/RemoteAgentShellRunner") {}

function workspaceHandle(executionTargetId: string, cwd: string): string {
  return `workspace-${createHash("sha256")
    .update(`${executionTargetId}\u0000${cwd}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function operationId(): string {
  return `shell-${randomUUID()}`;
}

function requestDigest(input: unknown): Uint8Array {
  return remoteAgentRequestDigest(input);
}

export function makeRemoteAgentShellRunnerResolver(input: {
  readonly runOwned?: OwnedRemoteProcessRunner;
  readonly cancelOwned?: (ownerKey: string) => Promise<void>;
  readonly isOwnedActive?: (ownerKey: string) => Promise<boolean>;
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentProcessClient>;
}): RemoteAgentShellRunnerResolver {
  const runners = new Map<string, ThreadShellRunnerShape>();

  return {
    resolve: (executionTargetId) => {
      const existing = runners.get(executionTargetId);
      if (existing) {
        return existing;
      }

      const active = new Map<
        string,
        { readonly client: RemoteAgentProcessClient; readonly operationId: string }
      >();
      const runner = {
        isActive: (threadId) =>
          input.isOwnedActive
            ? Effect.tryPromise({
                try: () => input.isOwnedActive!(`shell:${threadId}`),
                catch: () => true,
              }).pipe(Effect.catch(() => Effect.succeed(true)))
            : Effect.succeed(active.has(threadId)),
        run: (runInput) => {
          const id = operationId();
          let terminalVerified = false;
          return Effect.tryPromise({
            try: async () => {
              if (input.runOwned) {
                const result = await input.runOwned({
                  ownerKey: `shell:${runInput.threadId}`,
                  invocationId: runInput.invocationId ?? id,
                  target: executionTargetId,
                  cwd: runInput.cwd,
                  newAfterTerminal: true,
                  request: {
                    workspaceHandle: workspaceHandle(executionTargetId, runInput.cwd),
                    operationId: runInput.invocationId ?? id,
                    requestDigest: requestDigest({
                      target: executionTargetId,
                      cwd: runInput.cwd,
                      command: runInput.command,
                      timeoutMs: runInput.timeoutMs ?? 30_000,
                    }),
                    command: "/bin/sh",
                    args: ["-lc", runInput.command],
                    timeoutMs: runInput.timeoutMs ?? 30_000,
                  },
                });
                const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
                if (output) runInput.onOutputChunk?.(output);
                return {
                  output,
                  exitCode: result.completed.hasExitCode ? result.completed.exitCode : null,
                };
              }
              if (active.has(runInput.threadId)) {
                throw new Error(
                  "Remote shell owner has unresolved work; resolve its outcome before a new invocation.",
                );
              }
              const client = await input.resolve(executionTargetId);
              const workspace = new RemoteAgentWorkspaceClient(client.connection);
              const handle = workspaceHandle(executionTargetId, runInput.cwd);
              await workspace.openWorkspace(handle, runInput.cwd);
              if (active.has(runInput.threadId)) {
                throw new Error("Remote shell owner already has unresolved work.");
              }
              active.set(runInput.threadId, { client, operationId: id });
              const result = await client.run({
                workspaceHandle: handle,
                operationId: runInput.invocationId ?? id,
                requestDigest: requestDigest({ ...runInput, executionTargetId }),
                command: "/bin/sh",
                args: ["-lc", runInput.command],
                timeoutMs: runInput.timeoutMs ?? 30_000,
              });
              const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
              terminalVerified = true;
              if (output.length > 0) runInput.onOutputChunk?.(output);
              return {
                output,
                exitCode: result.completed.hasExitCode ? result.completed.exitCode : null,
              };
            },
            catch: (cause) =>
              new ThreadShellRunnerError({
                message:
                  cause instanceof Error ? cause.message : "Failed to run remote shell command.",
                cause,
              }),
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const current = active.get(runInput.threadId);
                if (terminalVerified && current?.operationId === id)
                  active.delete(runInput.threadId);
              }),
            ),
          );
        },
        closeThread: (threadId) =>
          Effect.tryPromise({
            try: async () => {
              if (input.cancelOwned) return input.cancelOwned(`shell:${threadId}`);
              const running = active.get(threadId);
              if (running) {
                await running.client.cancelAndWait({ operationId: running.operationId });
                if (active.get(threadId) === running) active.delete(threadId);
              }
            },
            catch: (cause) =>
              new ThreadShellRunnerError({
                message:
                  cause instanceof Error ? cause.message : "Failed to cancel remote shell command.",
                cause,
              }),
          }).pipe(Effect.asVoid),
      } satisfies ThreadShellRunnerShape;
      runners.set(executionTargetId, runner);
      return runner;
    },
  };
}
