import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import { LOCAL_EXECUTION_TARGET_ID } from "@bigbud/contracts";

import { normalizeManagedServerStartError } from "./ServerManager.errors.ts";
import type { ProcessLedgerShape } from "../../../process-ledger/Services/ProcessLedger.ts";
import {
  readManagedServerListeningUrl,
  stopSpawnedChild,
  stopSpawnedChildAndWait,
  trackManagedServerChild,
} from "./ServerManager.helpers.ts";
import type { ManagedServerConfig, RunningManagedServer } from "./ServerManager.ts";

const LOCAL_HOST = "127.0.0.1";
const LOCAL_OPENCODE_START_TIMEOUT_MS = 5_000;

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
      if (url) finish(() => resolve(url));
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
  readonly ledger?: ProcessLedgerShape | undefined;
}): Promise<RunningManagedServer> {
  // The OpenCode v1 SSH transport is retired: remote OpenCode runs only through
  // the owner-selected v2 lane, so a remote target is refused before any spawn.
  if (input.executionTargetId !== LOCAL_EXECUTION_TARGET_ID) {
    throw new Error(
      `Remote ${input.config.displayName} v1 is retired; use OpenCode v2 for SSH targets.`,
    );
  }
  const invocation = {
    command: input.binaryPath,
    args: ["serve", `--hostname=${LOCAL_HOST}`, "--port=0"],
  };
  const child = spawn(invocation.command, invocation.args, {
    env: { ...process.env, [input.config.configContentEnvKey]: JSON.stringify({}) },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  void trackManagedServerChild(input.ledger, child, invocation, `${input.config.provider}-server`);
  let stopping = false;
  const onUnexpectedDeath = watchChild(child, () => stopping);
  const url = await waitForServer(child, LOCAL_OPENCODE_START_TIMEOUT_MS, input);
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
