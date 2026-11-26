import { randomUUID } from "node:crypto";

import { type ExecutionTargetId } from "@bigbud/contracts";

import type { ProcessRunOptions, ProcessRunResult } from "../utils/processRunner.ts";
import {
  makeProductionProviderWorkspaceShell,
  type SelectedProviderWorkspaceShell,
} from "../ws/remoteWorkspaceProviderShell.ts";
import { assertSelectedSshToolTransportAvailable } from "./toolTransport.ssh.errors.ts";

export {
  SelectedSshToolTransportError,
  assertSelectedSshToolTransportAvailable,
} from "./toolTransport.ssh.errors.ts";

export interface RunSshToolCommandInput {
  readonly executionTargetId: ExecutionTargetId;
  readonly invocationId?: string | undefined;
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

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type ShellSource = (targetId: string, workspaceRoot: string) => SelectedProviderWorkspaceShell;

/** The shell text of exactly `sh -lc <text>`, or undefined for any other argv. */
function shellText(input: RunSshToolCommandInput): string | undefined {
  const args = input.args ?? [];
  return input.command === "sh" && args.length === 2 && args[0] === "-lc" ? args[1] : undefined;
}

/**
 * Generic command over a direct SSH target (W7). SSH runs only through the Rust
 * owner, so the one admitted shape is the provider workspace shell grant
 * (`run_provider_workspace_shell`): exactly `sh -lc <text>` in an absolute
 * workspace root, with no stdin, PTY or environment, 30 s default / 120 s
 * ceiling and 8 MiB of combined output. Every other shape is refused before
 * anything is dispatched; there is no TypeScript SSH process.
 */
export async function runSshToolCommand(
  input: RunSshToolCommandInput,
  shellFor: ShellSource = makeProductionProviderWorkspaceShell,
): Promise<ProcessRunResult> {
  const text = shellText(input);
  const cwd = input.cwd;
  if (
    text === undefined ||
    input.stdin !== undefined ||
    input.allocateTty === true ||
    (input.env !== undefined && Object.keys(input.env).length > 0) ||
    cwd === undefined ||
    !cwd.startsWith("/") ||
    cwd === "/"
  )
    return assertSelectedSshToolTransportAvailable();
  input.signal?.throwIfAborted();
  const shell = shellFor(input.executionTargetId, cwd);
  // A fresh identity per call: a repeated command is a new run, never a replay.
  const invocationId = input.invocationId ?? randomUUID();
  const result = await shell.run(
    {
      workspaceRoot: cwd,
      cwd,
      // The owner admits a closed provider-label set; generic tools use the thread-tool label.
      provider: "thread-tool",
      sessionId: invocationId.slice(0, 128),
      invocationId: invocationId.slice(0, 128),
      command: text,
      timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    },
    input.signal,
  );
  const limit = Math.min(input.maxBufferBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
  const bytes = Buffer.from(result.output);
  const overflow = result.truncated || bytes.length > limit;
  if (overflow && input.outputMode !== "truncate")
    throw new Error("Remote tool command output exceeded the buffer limit.");
  if (result.timedOut) throw new Error("Remote tool command timed out and was not replayed.");
  if (result.exitCode !== 0 && input.allowNonZeroExit !== true)
    throw new Error(`Remote tool command exited with code ${result.exitCode}.`);
  return {
    stdout: bytes.length > limit ? bytes.subarray(0, limit).toString("utf8") : result.output,
    stderr: "",
    code: result.exitCode,
    signal: null,
    timedOut: false,
    ...(overflow ? { stdoutTruncated: true } : {}),
  };
}
