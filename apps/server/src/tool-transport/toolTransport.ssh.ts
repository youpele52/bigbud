import { type ExecutionTargetId } from "@bigbud/contracts";

import type { ProcessRunOptions, ProcessRunResult } from "../utils/processRunner.ts";
import { assertSelectedSshToolTransportAvailable } from "./toolTransport.ssh.errors.ts";

export {
  SelectedSshToolTransportError,
  assertSelectedSshToolTransportAvailable,
} from "./toolTransport.ssh.errors.ts";

export interface RunSshToolCommandInput {
  readonly executionTargetId: ExecutionTargetId;
  readonly signal?: AbortSignal;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string>> | undefined;
  readonly command: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly allocateTty?: boolean | undefined;
  readonly stdin?: string | undefined;
  readonly allowNonZeroExit?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBufferBytes?: number | undefined;
  readonly outputMode?: ProcessRunOptions["outputMode"] | undefined;
}

/**
 * Generic command over a direct SSH target. SSH runs only through the Rust owner,
 * which has no generic runner, so this always refuses before any process exists.
 */
export async function runSshToolCommand(_input: RunSshToolCommandInput): Promise<ProcessRunResult> {
  assertSelectedSshToolTransportAvailable();
}
