import { spawn, type ChildProcess } from "node:child_process";

import type { RemoteAgentPtyResolver } from "../remote-agent/remoteAgentPtyAdapter.ts";
import { createRemoteAgentWorkspacePty } from "../remote-agent/remoteAgentPtyAdapter.ts";
import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";

export interface AcpTerminalProcess {
  kill(signal?: NodeJS.Signals): void;
  onData(callback: (data: string) => void): () => void;
  onExit(
    callback: (event: { exitCode: number; signal: string | number | null }) => void,
  ): () => void;
  onError(callback: (error: Error) => void): () => void;
  close(terminate?: boolean): Promise<void>;
}

function makeSshTerminalProcess(child: ChildProcess): AcpTerminalProcess {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<
    (event: { exitCode: number; signal: string | number | null }) => void
  >();
  const errorListeners = new Set<(error: Error) => void>();
  child.stdout?.on("data", (chunk) => {
    const data = String(chunk);
    for (const listener of dataListeners) listener(data);
  });
  child.stderr?.on("data", (chunk) => {
    const data = String(chunk);
    for (const listener of dataListeners) listener(data);
  });
  child.on("error", (error) => {
    for (const listener of errorListeners) listener(error);
  });
  child.on("exit", (exitCode, signal) => {
    for (const listener of exitListeners) listener({ exitCode: exitCode ?? 0, signal });
  });
  return {
    kill: (signal = "SIGTERM") => child.kill(signal),
    onData: (callback) => {
      dataListeners.add(callback);
      return () => dataListeners.delete(callback);
    },
    onExit: (callback) => {
      exitListeners.add(callback);
      return () => exitListeners.delete(callback);
    },
    onError: (callback) => {
      errorListeners.add(callback);
      return () => errorListeners.delete(callback);
    },
    close: async (terminate = true) => {
      if (!terminate || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
    },
  };
}

export async function createRemoteWorkspaceAcpTerminal(input: {
  readonly executionTargetId: string;
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly ptyResolver: RemoteAgentPtyResolver | undefined;
}): Promise<AcpTerminalProcess> {
  if (input.ptyResolver) {
    return createRemoteAgentWorkspacePty(
      {
        executionTargetId: input.executionTargetId,
        workspaceRoot: input.workspaceRoot,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        command: input.command,
        args: input.args ?? [],
        cols: 80,
        rows: 24,
        ...(input.environment ? { environment: input.environment } : {}),
      },
      input.ptyResolver,
    );
  }

  const invocation = buildSshCommandInvocation({
    executionTargetId: input.executionTargetId,
    cwd: input.cwd ?? input.workspaceRoot,
    command: input.command,
    args: input.args ?? [],
    env: Object.fromEntries(input.environment?.map(({ name, value }) => [name, value]) ?? []),
  });
  return makeSshTerminalProcess(
    spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    }),
  );
}
