import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";

import { buildSshCommandInvocation } from "../../../ssh/sshCommand.ts";
import { assertSshExecutionTargetReady } from "../../../ssh/sshVerification.ts";
import { normalizeManagedServerStartError } from "./ServerManager.errors.ts";
import {
  readManagedServerListeningUrl,
  stopSpawnedChild,
  stopSpawnedChildAndWait,
} from "./ServerManager.helpers.ts";
import type { ManagedServerConfig, RunningManagedServer } from "./ServerManager.ts";

const LOCAL_HOST = "127.0.0.1";
const LOCAL_OPENCODE_START_TIMEOUT_MS = 5_000;
const REMOTE_OPENCODE_START_TIMEOUT_MS = 8_000;
const REMOTE_OPENCODE_PORT = 4096;

async function allocateLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, LOCAL_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port.")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function watchChild(
  child: ChildProcess,
  isStopping: () => boolean,
): NonNullable<RunningManagedServer["onUnexpectedDeath"]> {
  let dead = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    if (isStopping() || dead) return;
    dead = true;
    for (const listener of listeners) listener();
  };
  child.on("error", notify);
  child.on("exit", notify);
  child.on("close", notify);
  return (listener) => {
    listeners.add(listener);
    if (dead) listener();
    return () => listeners.delete(listener);
  };
}

async function waitForServer(
  child: ChildProcess,
  timeoutMs: number,
  input: {
    readonly config: ManagedServerConfig;
    readonly binaryPath: string;
    readonly executionTargetId: string;
    readonly resolvedUrl?: string;
  },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const stdout = readline.createInterface(child.stdout!);
    const stderr = readline.createInterface(child.stderr!);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.close();
      stderr.close();
      child.off("error", fail);
      child.off("exit", onExit);
      callback();
    };
    const fail = (error: unknown) =>
      finish(() => {
        stopSpawnedChild(child);
        reject(normalizeManagedServerStartError({ ...input, error, output }));
      });
    const onExit = (code: number | null) =>
      fail(
        new Error(
          `${input.config.displayName} server exited with code ${code ?? "null"}.\n${output}`,
        ),
      );
    const onLine = (line: string) => {
      output += `${line}\n`;
      const url = readManagedServerListeningUrl(line);
      if (url) finish(() => resolve(input.resolvedUrl ?? url));
    };
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `Timeout waiting for ${input.config.displayName} server to start after ${timeoutMs}ms.\n${output}`,
          ),
        ),
      timeoutMs,
    );
    stdout.on("line", onLine);
    stderr.on("line", onLine);
    child.once("error", fail);
    child.once("exit", onExit);
  });
}

async function startChild(input: {
  readonly config: ManagedServerConfig;
  readonly executionTargetId: string;
  readonly binaryPath: string;
}): Promise<RunningManagedServer> {
  const isLocal = input.executionTargetId === LOCAL_EXECUTION_TARGET_ID;
  const localPort = isLocal ? undefined : await allocateLocalPort();
  if (!isLocal) assertSshExecutionTargetReady(input.executionTargetId);
  const invocation = isLocal
    ? { command: input.binaryPath, args: ["serve", `--hostname=${LOCAL_HOST}`, "--port=0"] }
    : buildSshCommandInvocation({
        executionTargetId: input.executionTargetId,
        cwd: "",
        command: input.binaryPath,
        args: ["serve", `--hostname=${LOCAL_HOST}`, `--port=${REMOTE_OPENCODE_PORT}`],
        transportArgs: [
          "-o",
          "ExitOnForwardFailure=yes",
          "-L",
          `${localPort}:${LOCAL_HOST}:${REMOTE_OPENCODE_PORT}`,
        ],
      });
  const child = spawn(invocation.command, invocation.args, {
    env: { ...process.env, [input.config.configContentEnvKey]: JSON.stringify({}) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  let stopping = false;
  const onUnexpectedDeath = watchChild(child, () => stopping);
  const url = await waitForServer(
    child,
    isLocal ? LOCAL_OPENCODE_START_TIMEOUT_MS : REMOTE_OPENCODE_START_TIMEOUT_MS,
    { ...input, ...(localPort ? { resolvedUrl: `http://${LOCAL_HOST}:${localPort}` } : {}) },
  );
  return {
    url,
    isRunning: () => child.exitCode === null && child.signalCode === null && !child.killed,
    onUnexpectedDeath,
    close: async () => {
      stopping = true;
      await stopSpawnedChildAndWait(child);
    },
  };
}

export { startChild as startManagedServer };
