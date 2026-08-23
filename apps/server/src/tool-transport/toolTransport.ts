import type { ExecutionTargetId } from "@bigbud/contracts/core/baseSchemas.ts";

import type { ProcessRunResult } from "../utils/processRunner.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { isLocalWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { runLocalToolCommand } from "./toolTransport.local.ts";
import { runSshToolCommand } from "./toolTransport.ssh.ts";
import {
  getConfiguredRemoteAgentComposition,
  resolveRemoteAgentConfiguration,
} from "../remote-agent/remoteAgentDefault.ts";

export type ToolExecutionTransport = "agent" | "local" | "ssh";

export interface ToolTransportTarget {
  readonly transport: ToolExecutionTransport;
  readonly executionTargetId: ExecutionTargetId;
  readonly cwd: string | undefined;
}

export interface RunToolCommandInput {
  readonly target: ToolTransportTarget;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allocateTty?: boolean;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly outputMode?: "error" | "truncate";
}

export function resolveToolTransportTarget(workspaceTarget: WorkspaceTarget): ToolTransportTarget {
  const remoteTransport = resolveRemoteAgentConfiguration().transport;
  return {
    transport: isLocalWorkspaceTarget(workspaceTarget)
      ? "local"
      : remoteTransport === "direct-ssh"
        ? "ssh"
        : "agent",
    executionTargetId: workspaceTarget.executionTargetId,
    cwd: workspaceTarget.cwd,
  };
}

export function runToolCommand(input: RunToolCommandInput): Promise<ProcessRunResult> {
  if (input.target.transport === "local") {
    return runLocalToolCommand({
      command: input.command,
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.target.cwd !== undefined ? { cwd: input.target.cwd } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
    });
  }

  if (input.target.transport === "agent") {
    const composition = getConfiguredRemoteAgentComposition();
    if (!composition) {
      throw new Error("Remote agent transport is not configured.");
    }
    if (!input.target.cwd) {
      throw new Error("Remote agent transport requires an explicit workspace root.");
    }
    return composition.toolRunner({
      executionTargetId: input.target.executionTargetId,
      cwd: input.target.cwd,
      command: input.command,
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
    });
  }

  return runSshToolCommand({
    executionTargetId: input.target.executionTargetId,
    command: input.command,
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.target.cwd !== undefined ? { cwd: input.target.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.allocateTty !== undefined ? { allocateTty: input.allocateTty } : {}),
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
    ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
  });
}
