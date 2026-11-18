import { randomUUID } from "node:crypto";
import { getConfiguredRemoteAgentComposition } from "./remoteAgentDefault.ts";
import type { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import {
  remoteAgentProcessRequestDigest,
  remoteAgentWorkspaceHandle,
} from "./remoteAgentProcessRequest.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { withCommandCancellation } from "../utils/commandCancellation.ts";
import type { ProcessRunResult } from "../utils/processRunner.ts";

export interface RemoteAgentShellInventoryInput {
  readonly executionTargetId: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
}

export interface RemoteAgentShellInventoryDependencies {
  readonly resolve?: (target: string) => Promise<{
    readonly process: Pick<RemoteAgentProcessClient, "run" | "cancelAndWait">;
    readonly openWorkspace: (handle: string, cwd: string) => Promise<unknown>;
  }>;
}

/** Raw authenticated process lane: unlike the general tool runner, never strips a BOM
 * or replaces malformed UTF-8. No project cwd/environment or durable invocation is used.
 */
export async function runRemoteAgentShellInventory(
  input: RemoteAgentShellInventoryInput,
  dependencies: RemoteAgentShellInventoryDependencies = {},
): Promise<ProcessRunResult> {
  input.signal.throwIfAborted();
  const resolve =
    dependencies.resolve ??
    (async (target: string) => {
      const composition = getConfiguredRemoteAgentComposition();
      if (!composition) throw new Error("Remote agent is unavailable.");
      const process = await composition.pool.getProcessClient(target);
      const workspace = new RemoteAgentWorkspaceClient(process.connection);
      return {
        process,
        openWorkspace: (handle: string, cwd: string) => workspace.openWorkspace(handle, cwd),
      };
    });
  const client = await resolve(input.executionTargetId);
  input.signal.throwIfAborted();
  const cwd = "/";
  const workspaceHandle = remoteAgentWorkspaceHandle({ ...input, cwd });
  await client.openWorkspace(workspaceHandle, cwd);
  // Connection/workspace setup is not abortable. Never dispatch after it finishes late.
  input.signal.throwIfAborted();
  const operationId = `shell-inventory:${randomUUID()}`;
  const command = "/usr/bin/env";
  const environment: readonly { readonly name: string; readonly value: string }[] = [];
  const request = {
    workspaceHandle,
    operationId,
    requestDigest: remoteAgentProcessRequestDigest({
      executionTargetId: input.executionTargetId,
      cwd,
      command,
      args: input.args,
      environment,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxBufferBytes,
    }),
    command,
    args: input.args,
    environment,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxBufferBytes,
    signal: input.signal,
  };
  const result = await withCommandCancellation(
    input.signal,
    () => client.process.run(request),
    () => client.process.cancelAndWait({ operationId }),
  );
  input.signal.throwIfAborted();
  if (
    result.replayGap ||
    result.completed.outputTruncated ||
    result.stdout.byteLength + result.stderr.byteLength > input.maxBufferBytes
  )
    throw new Error("Incomplete remote shell inventory output.");
  // ignoreBOM=true preserves U+FEFF so the complete-frame decoder rejects it.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return {
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
    code: result.completed.hasExitCode ? result.completed.exitCode : null,
    signal: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
