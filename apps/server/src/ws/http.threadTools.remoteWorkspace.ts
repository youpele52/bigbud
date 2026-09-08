import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { isLocalExecutionTarget } from "../executionTargets.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { resolveToolTransportTarget, runToolCommand } from "../tool-transport/toolTransport.ts";
import { resolveWorkspaceExecutionTargetId } from "../workspace-target/workspaceTarget.ts";
import { ThreadToolRequestError } from "./http.threadTools.schema.ts";

const MAX_REMOTE_TIMEOUT_MS = 120_000;
const MAX_REMOTE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_REMOTE_STDIN_BYTES = 1024 * 1024;
const MAX_REMOTE_COMMAND_BYTES = 4 * 1024;
const MAX_REMOTE_ARGUMENT_BYTES = 1024 * 1024;
const MAX_REMOTE_ARGUMENT_COUNT = 256;

export interface RemoteWorkspaceProcessRequest {
  readonly remoteCommand?: string | undefined;
  readonly remoteArgs?: ReadonlyArray<string> | undefined;
  readonly remoteStdin?: string | undefined;
  readonly remoteAllowNonZeroExit?: boolean | undefined;
  readonly remoteTimeoutMs?: number | undefined;
  readonly remoteMaxOutputBytes?: number | undefined;
  readonly remoteOutputMode?: "error" | "truncate" | undefined;
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
  readonly request: RemoteWorkspaceProcessRequest;
}) {
  const command = input.request.remoteCommand?.trim() ?? "";
  if (!command || command.includes("\0") || Buffer.byteLength(command) > MAX_REMOTE_COMMAND_BYTES) {
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
  const readModel = yield* orchestrationEngine.getReadModel();
  const thread = readModel.threads.find(({ id }) => id === input.callerThreadId);
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

  return yield* Effect.tryPromise({
    try: () =>
      runToolCommand({
        target: resolveToolTransportTarget({
          location: "remote",
          executionTargetId,
          cwd,
        }),
        command,
        args,
        ...(input.request.remoteStdin !== undefined ? { stdin: input.request.remoteStdin } : {}),
        allowNonZeroExit: input.request.remoteAllowNonZeroExit === true,
        timeoutMs,
        maxBufferBytes,
        outputMode: input.request.remoteOutputMode ?? "error",
      }),
    catch: (cause) =>
      new ThreadToolRequestError({
        status: 502,
        message:
          cause instanceof Error ? cause.message : "Remote workspace process execution failed.",
      }),
  });
});
