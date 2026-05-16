import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { assertSupportedCodexCliVersion } from "./codexVersionCheck.ts";
import { startRemoteCodexAppServerProcess } from "./codexAppServerManager.process.remote.ts";
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

  return spawn(input.binaryPath, ["app-server", ...(input.configArgs ?? [])], {
    cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}
