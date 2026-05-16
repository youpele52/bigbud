import {
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../utils/processRunner.ts";
import { buildSshCommandInvocation } from "./sshCommand.ts";
import { assertSshExecutionTargetReady } from "./sshVerification.ts";

export interface RunSshCommandInput {
  readonly executionTargetId: string | null | undefined;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly allocateTty?: boolean;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly outputMode?: ProcessRunOptions["outputMode"];
}

export async function runSshCommand(input: RunSshCommandInput): Promise<ProcessRunResult> {
  assertSshExecutionTargetReady(input.executionTargetId);
  const invocation = buildSshCommandInvocation(input);
  return runProcess(invocation.command, invocation.args, {
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
    ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
  });
}
