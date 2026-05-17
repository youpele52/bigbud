import { type ExecutionTargetId } from "@bigbud/contracts";

import { runSshCommand, type RunSshCommandInput } from "../ssh/sshProcess.ts";

export interface RunSshToolCommandInput {
  readonly executionTargetId: ExecutionTargetId;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined;
  readonly command: RunSshCommandInput["command"];
  readonly args?: ReadonlyArray<string> | undefined;
  readonly allocateTty?: boolean | undefined;
  readonly stdin?: string | undefined;
  readonly allowNonZeroExit?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBufferBytes?: number | undefined;
  readonly outputMode?: RunSshCommandInput["outputMode"] | undefined;
}

function normalizeEnvironment(
  env: RunSshToolCommandInput["env"],
): Readonly<Record<string, string>> | undefined {
  if (!env) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export function runSshToolCommand(input: RunSshToolCommandInput) {
  const env = normalizeEnvironment(input.env);
  return runSshCommand({
    executionTargetId: input.executionTargetId,
    command: input.command,
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(input.allocateTty !== undefined ? { allocateTty: input.allocateTty } : {}),
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxBufferBytes !== undefined ? { maxBufferBytes: input.maxBufferBytes } : {}),
    ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
  });
}
