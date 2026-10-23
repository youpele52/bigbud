import {
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../utils/processRunner.ts";
import { buildSshCommandInvocation } from "./sshCommand.ts";
import { assertSshExecutionTargetReadyAsync } from "./sshVerification.ts";
import { inspectSshHostTrust, inspectSshHostTrustOnFailure } from "./sshHostTrust.ts";

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
  readonly onStdoutChunk?: ProcessRunOptions["onStdoutChunk"];
}

export async function runSshCommand(input: RunSshCommandInput): Promise<ProcessRunResult> {
  await assertSshExecutionTargetReadyAsync(input.executionTargetId);
  const invocation = buildSshCommandInvocation(input);
  const result = await runProcess(invocation.command, invocation.args, {
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
    ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
    ...(input.onStdoutChunk ? { onStdoutChunk: input.onStdoutChunk } : {}),
  }).catch((error: unknown) =>
    inspectSshHostTrustOnFailure(input.executionTargetId ?? "local", error),
  );
  if (/host key verification failed/i.test(result.stderr)) {
    await inspectSshHostTrust(input.executionTargetId ?? "local");
  }
  return result;
}
