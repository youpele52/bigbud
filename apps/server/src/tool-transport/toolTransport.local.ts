import {
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../utils/processRunner.ts";

export interface RunLocalToolCommandInput {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: ProcessRunOptions["env"];
  readonly stdin?: ProcessRunOptions["stdin"];
  readonly allowNonZeroExit?: ProcessRunOptions["allowNonZeroExit"];
  readonly timeoutMs?: ProcessRunOptions["timeoutMs"];
  readonly maxBufferBytes?: ProcessRunOptions["maxBufferBytes"];
  readonly outputMode?: ProcessRunOptions["outputMode"];
}

export function runLocalToolCommand(input: RunLocalToolCommandInput): Promise<ProcessRunResult> {
  return runProcess(input.command, input.args ?? [], {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
    ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
  });
}
