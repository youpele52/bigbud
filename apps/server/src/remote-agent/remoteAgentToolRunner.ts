import { randomUUID } from "node:crypto";

import type { ProcessRunResult } from "../utils/processRunner.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import {
  remoteAgentProcessRequestDigest,
  remoteAgentWorkspaceHandle,
} from "./remoteAgentProcessRequest.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

export interface RemoteAgentToolRunInput {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly outputMode?: "error" | "truncate";
}

export type RemoteAgentToolRunner = (input: RemoteAgentToolRunInput) => Promise<ProcessRunResult>;

const ALLOWED_REMOTE_AGENT_ENVIRONMENT = new Set([
  "CI",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
]);

function environment(input: NodeJS.ProcessEnv | undefined) {
  return Object.entries(input ?? {}).flatMap(([name, value]) => {
    if (value === undefined) return [];
    if (ALLOWED_REMOTE_AGENT_ENVIRONMENT.has(name)) {
      return [{ name, value }];
    }
    return [];
  });
}

function commandLabel(input: RemoteAgentToolRunInput): string {
  return [input.command, ...(input.args ?? [])].join(" ");
}

export function makeRemoteAgentToolRunner(input: {
  readonly resolve: (executionTargetId: string) => Promise<RemoteAgentProcessClient>;
}): RemoteAgentToolRunner {
  return async (runInput) => {
    const client = await input.resolve(runInput.executionTargetId);
    const handle = remoteAgentWorkspaceHandle(runInput);
    const args = runInput.args ?? [];
    const requestEnvironment = environment(runInput.env);
    const timeoutMs = runInput.timeoutMs ?? 30_000;
    const maxOutputBytes = runInput.maxBufferBytes ?? 8 * 1024 * 1024;
    await new RemoteAgentWorkspaceClient(client.connection).openWorkspace(handle, runInput.cwd);
    const result = await client.run({
      workspaceHandle: handle,
      operationId: `tool-${randomUUID()}`,
      requestDigest: remoteAgentProcessRequestDigest({
        executionTargetId: runInput.executionTargetId,
        cwd: runInput.cwd,
        command: runInput.command,
        args,
        environment: requestEnvironment,
        timeoutMs,
        maxOutputBytes,
        ...(runInput.stdin !== undefined ? { stdin: runInput.stdin } : {}),
      }),
      command: runInput.command,
      args,
      timeoutMs,
      maxOutputBytes,
      environment: requestEnvironment,
      ...(runInput.stdin !== undefined ? { stdin: new TextEncoder().encode(runInput.stdin) } : {}),
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const code = result.completed.hasExitCode ? result.completed.exitCode : null;
    const truncated = result.completed.outputTruncated;
    if (truncated && runInput.outputMode !== "truncate") {
      throw new Error(
        `${commandLabel(runInput)} exceeded the remote agent output limit (${runInput.maxBufferBytes ?? 8 * 1024 * 1024} bytes).`,
      );
    }
    if (code !== 0 && runInput.allowNonZeroExit !== true) {
      const detail = stderr.trim();
      throw new Error(
        `${commandLabel(runInput)} failed (code=${code ?? "null"}).${detail ? ` ${detail}` : ""}`,
      );
    }
    return {
      stdout,
      stderr,
      code,
      signal: null,
      timedOut: false,
      stdoutTruncated: truncated,
      stderrTruncated: truncated,
    };
  };
}
