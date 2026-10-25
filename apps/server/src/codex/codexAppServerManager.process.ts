import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { assertSupportedCodexCliVersion } from "./codexVersionCheck.ts";
import {
  startRemoteCodexAppServerProcess,
  startRemoteCodexAppServerProcessAsync,
} from "./codexAppServerManager.process.remote.ts";
import { recordEarlySpawnError } from "./codexAppServerManager.process.spawnError.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

function resolveProviderRuntimeExecutionTargetId(input: CodexAppServerStartSessionInput): string {
  return input.providerRuntimeExecutionTargetId ?? input.executionTargetId ?? "local";
}

export function startCodexAppServerProcess(
  input: CodexAppServerStartSessionInput,
  cwd: string,
): ChildProcessWithoutNullStreams {
  if (!isLocalExecutionTarget(resolveProviderRuntimeExecutionTargetId(input))) {
    return startRemoteCodexAppServerProcess({
      ...input,
      cwd,
    });
  }

  assertSupportedCodexCliVersion({
    binaryPath: input.binaryPath,
    cwd,
    ...(input.homePath ? { homePath: input.homePath } : {}),
  });

  return recordEarlySpawnError(
    spawn(input.binaryPath, ["app-server", ...(input.configArgs ?? [])], {
      cwd,
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    }),
  );
}

/**
 * Session start entry point: the remote SSH readiness and version checks never
 * block the event loop, and an aborted `signal` stops the remote app-server
 * from being spawned after the check. Local starts are unchanged.
 */
export async function startCodexAppServerProcessAsync(
  input: CodexAppServerStartSessionInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<ChildProcessWithoutNullStreams> {
  if (!isLocalExecutionTarget(resolveProviderRuntimeExecutionTargetId(input))) {
    return startRemoteCodexAppServerProcessAsync({ ...input, cwd }, signal);
  }
  return startCodexAppServerProcess(input, cwd);
}
