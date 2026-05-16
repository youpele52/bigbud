import { type ExecutionTargetId } from "@bigbud/contracts";

import type { ProcessRunResult } from "../utils/processRunner.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { isLocalWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { runLocalToolCommand } from "./toolTransport.local.ts";
import { runSshToolCommand } from "./toolTransport.ssh.ts";

export type ToolExecutionTransport = "local" | "ssh";

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
  return {
    transport: isLocalWorkspaceTarget(workspaceTarget) ? "local" : "ssh",
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
