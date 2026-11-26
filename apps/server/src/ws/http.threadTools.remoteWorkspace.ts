import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { createHash } from "node:crypto";

import { Effect } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  OrchestrationEngineService,
  getOrchestrationThreadWithReadModel,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget.ts";
import {
  isFixedProviderShellCommand,
  makeProductionProviderWorkspaceShell,
  PROVIDER_SHELL_REFUSAL,
} from "./remoteWorkspaceProviderShell.ts";
import type { RemoteWorkspaceExecutions } from "../remote-workspace-bridge/remoteWorkspaceExecutions.ts";
import type { ThreadToolWorkspaceBinding } from "../orchestration-tools/ThreadOrchestrationToolAuth.ts";
import { isRemoteAgentExecutionTarget } from "../remote-agent/remoteAgentDefault.ts";
import { resolveToolTransportTarget, runToolCommand } from "../tool-transport/toolTransport.ts";
import { ThreadToolRequestError } from "./http.threadTools.schema.ts";
import { dispatchRemoteWorkspaceTool } from "./http.threadTools.remoteWorkspaceTool.dispatch.ts";

const MAX_REMOTE_TIMEOUT_MS = 120_000;
const MAX_REMOTE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_STDIN_BYTES = 1024 * 1024;
const MAX_REMOTE_COMMAND_BYTES = 4 * 1024;
const MAX_REMOTE_ARGUMENT_BYTES = 1024 * 1024;
const MAX_REMOTE_ARGUMENT_COUNT = 256;

export interface RemoteWorkspaceProcessRequest {
  readonly remoteInvocationId?: string | undefined;
  readonly remoteCommand?: string | undefined;
  readonly remoteArgs?: ReadonlyArray<string> | undefined;
  readonly remoteStdin?: string | undefined;
  readonly remoteAllowNonZeroExit?: boolean | undefined;
  readonly remoteTimeoutMs?: number | undefined;
  readonly remoteMaxOutputBytes?: number | undefined;
  readonly remoteOutputMode?: "error" | "truncate" | undefined;
  /** Typed bridge tool (read/write/list/search); see `http.threadTools.remoteWorkspaceTool.ts`. */
  readonly remoteTool?: unknown;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new ThreadToolRequestError({
      status: 400,
      message: `${label} must be an integer between 1 and ${maximum}.`,
    });
  }
  return resolved;
}

export const runRemoteWorkspaceProcess = Effect.fn("runRemoteWorkspaceProcess")(function* (input: {
  readonly callerThreadId: ThreadId;
  /** Present for workspace-bound issuers (OpenCode v2); legacy providers retain their contract. */
  readonly workspaceBinding?: ThreadToolWorkspaceBinding | undefined;
  readonly executionOwner?: RemoteWorkspaceExecutions | undefined;
  readonly executionGeneration?: number | undefined;
  readonly request: RemoteWorkspaceProcessRequest;
}) {
  const owner = input.executionOwner;
  const generation = input.executionGeneration ?? owner?.captureGeneration();
  const invocationId = input.request.remoteInvocationId;
  if (!invocationId || invocationId.length > 256 || !/^[\x21-\x7e]+$/.test(invocationId))
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "A stable remote tool invocation identity is required.",
    });
  const command = input.request.remoteCommand?.trim() ?? "";
  const typedTool = input.request.remoteTool !== undefined;
  if (
    !typedTool &&
    (!command || command.includes("\0") || Buffer.byteLength(command) > MAX_REMOTE_COMMAND_BYTES)
  ) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "Remote workspace command is required.",
    });
  }
  const args = input.request.remoteArgs ?? [];
  if (
    args.length > MAX_REMOTE_ARGUMENT_COUNT ||
    args.some((argument) => argument.includes("\0")) ||
    args.reduce((total, argument) => total + Buffer.byteLength(argument), 0) >
      MAX_REMOTE_ARGUMENT_BYTES
  ) {
    return yield* new ThreadToolRequestError({
      status: 413,
      message: "Remote workspace arguments exceed the configured bounds.",
    });
  }
  if (
    input.request.remoteStdin &&
    Buffer.byteLength(input.request.remoteStdin) > MAX_REMOTE_STDIN_BYTES
  ) {
    return yield* new ThreadToolRequestError({
      status: 413,
      message: `Remote workspace stdin exceeds ${MAX_REMOTE_STDIN_BYTES} bytes.`,
    });
  }
  const timeoutMs = yield* Effect.try({
    try: () =>
      boundedPositiveInteger(
        input.request.remoteTimeoutMs,
        30_000,
        MAX_REMOTE_TIMEOUT_MS,
        "remoteTimeoutMs",
      ),
    catch: (error) => error as ThreadToolRequestError,
  });
  const maxBufferBytes = yield* Effect.try({
    try: () =>
      boundedPositiveInteger(
        input.request.remoteMaxOutputBytes,
        1024 * 1024,
        MAX_REMOTE_OUTPUT_BYTES,
        "remoteMaxOutputBytes",
      ),
    catch: (error) => error as ThreadToolRequestError,
  });

  const orchestrationEngine = yield* OrchestrationEngineService;
  const { readModel, thread } = yield* getOrchestrationThreadWithReadModel(
    orchestrationEngine,
    input.callerThreadId,
  );
  if (!thread) {
    return yield* new ThreadToolRequestError({ status: 404, message: "Current thread not found." });
  }
  const project = readModel.projects.find(({ id }) => id === thread.projectId);
  const executionTargetId = project
    ? resolveWorkspaceExecutionTargetId({
        executionTargetId: thread.executionTargetId ?? project.executionTargetId,
        workspaceExecutionTargetId:
          thread.workspaceExecutionTargetId ?? project.workspaceExecutionTargetId,
      })
    : resolveWorkspaceExecutionTargetId(thread);
  if (isLocalExecutionTarget(executionTargetId)) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "Current thread does not use a remote workspace.",
    });
  }
  const cwd = resolveThreadWorkspaceCwd({ thread, projects: readModel.projects });
  if (!cwd) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "Remote workspace root is not configured.",
    });
  }

  const binding = input.workspaceBinding;
  if (binding && (binding.executionTargetId !== executionTargetId || binding.cwd !== cwd)) {
    return yield* new ThreadToolRequestError({
      status: 409,
      message:
        "Remote workspace changed since these tools were connected. Restore the original VPS project or explicitly reconnect the thread; no command was dispatched.",
    });
  }

  if (binding && !owner)
    return yield* new ThreadToolRequestError({
      status: 409,
      message:
        "Remote command owner is unavailable. Reconnect workspace tools before running commands.",
    });

  const authorizedTarget = binding?.executionTargetId ?? executionTargetId;
  const authorizedCwd = binding?.cwd ?? cwd;
  const agentTarget = isRemoteAgentExecutionTarget(authorizedTarget);
  if (typedTool)
    return yield* dispatchRemoteWorkspaceTool({
      // Agent-transport targets use the remote agent (its proxy is an owner lease); direct
      // SSH targets use the owner's typed tools. Neither launches a TypeScript SSH process.
      mode: agentTarget ? "legacy" : "owner",
      remoteTool: input.request.remoteTool,
      callerThreadId: input.callerThreadId,
      invocationId,
      targetId: authorizedTarget,
      workspaceRoot: authorizedCwd,
      timeoutMs,
      executionOwner: owner,
      generation,
    });
  if (agentTarget) {
    const run = (signal?: AbortSignal) =>
      runToolCommand({
        ...(signal ? { signal } : {}),
        invocationId: createHash("sha256")
          .update(JSON.stringify([input.callerThreadId, invocationId]))
          .digest("hex"),
        target: resolveToolTransportTarget({
          location: "remote",
          // Dispatch the authorized snapshot, never re-resolve mutable project settings.
          executionTargetId: authorizedTarget,
          cwd: authorizedCwd,
        }),
        command,
        args,
        ...(input.request.remoteStdin !== undefined ? { stdin: input.request.remoteStdin } : {}),
        allowNonZeroExit: input.request.remoteAllowNonZeroExit === true,
        timeoutMs,
        maxBufferBytes,
        outputMode: input.request.remoteOutputMode ?? "error",
      });
    return yield* Effect.tryPromise({
      try: (signal) => {
        if (owner) {
          owner.assertGeneration(generation!);
          return owner.run(invocationId, run, signal);
        }
        return run();
      },
      catch: (cause) =>
        new ThreadToolRequestError({
          status: 502,
          message:
            cause instanceof Error ? cause.message : "Remote workspace process execution failed.",
        }),
    });
  }
  // Decision A: exactly `sh -lc <text>` (no further argv, no stdin) is the bash
  // tool's command text; the fixed-tool first-word check does not apply to it.
  const bashText =
    command === "sh" &&
    args.length === 2 &&
    args[0] === "-lc" &&
    input.request.remoteStdin === undefined
      ? args[1]!
      : undefined;
  if (input.request.remoteStdin !== undefined) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message: "The selected provider workspace shell does not accept stdin.",
    });
  }
  if (args.length > 0 && bashText === undefined) {
    return yield* new ThreadToolRequestError({
      status: 400,
      message:
        "The selected provider workspace shell accepts one remote command text, not caller-selected argv.",
    });
  }
  if (bashText === undefined && isFixedProviderShellCommand(command)) {
    return yield* new ThreadToolRequestError({ status: 400, message: PROVIDER_SHELL_REFUSAL });
  }
  // W2 T-shell: the owner runs the provider grant on the authorized snapshot.
  const selected = makeProductionProviderWorkspaceShell(authorizedTarget, authorizedCwd);
  if (
    !selected ||
    selected.targetId !== authorizedTarget ||
    selected.workspaceRoot !== authorizedCwd
  ) {
    return yield* new ThreadToolRequestError({
      status: 409,
      message:
        "Only the exact selected SSH workspace admits a provider shell. No command was dispatched and no legacy fallback was used.",
    });
  }
  const result = yield* Effect.tryPromise({
    try: (signal) => {
      const run = (runSignal?: AbortSignal) =>
        selected.run(
          {
            workspaceRoot: selected.workspaceRoot,
            cwd: authorizedCwd,
            provider: "thread-tool",
            sessionId: input.callerThreadId,
            invocationId,
            command: bashText ?? command,
            timeoutMs,
          },
          runSignal,
        );
      return owner ? owner.run(invocationId, run, signal) : run();
    },
    catch: (cause) =>
      new ThreadToolRequestError({
        status:
          cause instanceof Error && "code" in cause && cause.code === "shellTimedOut" ? 504 : 502,
        message: cause instanceof Error ? cause.message : "Remote provider shell execution failed.",
      }),
  });
  if (result.timedOut) {
    return yield* new ThreadToolRequestError({
      status: 504,
      message: "The remote provider shell timed out and was not replayed.",
    });
  }
  if (result.exitCode !== 0 && input.request.remoteAllowNonZeroExit !== true) {
    return yield* new ThreadToolRequestError({
      status: 502,
      message: `Remote provider shell exited with code ${result.exitCode}.`,
    });
  }
  let stdout = result.output;
  if (Buffer.byteLength(stdout) > maxBufferBytes) {
    stdout = Buffer.from(stdout).subarray(0, maxBufferBytes).toString("utf8");
  }
  return {
    stdout,
    stderr: "",
    code: result.exitCode,
    signal: null,
    timedOut: false,
    ...(result.truncated ? { stdoutTruncated: true } : {}),
  };
});
