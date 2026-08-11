import { spawn } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { LOCAL_EXECUTION_TARGET_ID, resolveExecutionTargetId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";

import { buildSshCommandInvocation } from "../../../ssh/sshCommand.ts";
import { assertSshExecutionTargetReady } from "../../../ssh/sshVerification.ts";
import {
  OpencodeServerManager,
  type OpencodeServerAcquireInput,
  type OpencodeServerHandle,
} from "../../Services/Opencode/ServerManager.ts";
import {
  buildClientOptions,
  readManagedServerListeningUrl,
  resolveBinaryPath,
  stopSpawnedChild,
  stopSpawnedChildAndWait,
} from "./ServerManager.helpers.ts";
import { normalizeManagedServerStartError } from "./ServerManager.errors.ts";
export { formatMissingOpencodeBinaryDetail } from "./ServerManager.errors.ts";
export { readManagedServerListeningUrl } from "./ServerManager.helpers.ts";

export interface RunningManagedServer {
  readonly url: string;
  isRunning?(): boolean;
  close(): void | Promise<void>;
}

interface TargetState {
  readonly targetKey: string;
  readonly targetIdentity: string;
  refCount: number;
  invalidated: boolean;
  closed: boolean;
  startPromise: Promise<RunningManagedServer> | null;
  serverHandle: RunningManagedServer | null;
}

const LOCAL_HOST = "127.0.0.1";
const LOCAL_OPENCODE_START_TIMEOUT_MS = 5_000;
const REMOTE_OPENCODE_START_TIMEOUT_MS = 8_000;
const REMOTE_OPENCODE_PORT = 4096;
type ManagedServerProvider = "opencode" | "kilocode";
const SERVER_CONFIGS = {
  opencode: {
    provider: "opencode",
    displayName: "OpenCode",
    defaultBinary: "opencode",
    configContentEnvKey: "OPENCODE_CONFIG_CONTENT",
  },
  kilocode: {
    provider: "kilocode",
    displayName: "KiloCode",
    defaultBinary: "kilo",
    configContentEnvKey: "KILO_CONFIG_CONTENT",
    directoryHeader: "x-kilo-directory",
  },
} as const;
export type ManagedServerConfig = (typeof SERVER_CONFIGS)[ManagedServerProvider];

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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForOpencodeServer(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  input: {
    readonly config: ManagedServerConfig;
    readonly binaryPath: string;
    readonly executionTargetId: string;
    readonly resolvedUrl?: string | null;
  },
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const stdout = readline.createInterface(child.stdout!);
    const stderr = readline.createInterface(child.stderr!);

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdout.close();
      stderr.close();
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      callback();
    };

    const fail = (error: unknown) =>
      finalize(() => {
        stopSpawnedChild(child);
        reject(
          normalizeManagedServerStartError({
            config: input.config,
            binaryPath: input.binaryPath,
            executionTargetId: input.executionTargetId,
            error,
            output,
          }),
        );
      });

    const onLine = (line: string) => {
      output += `${line}\n`;
      const parsedUrl = readManagedServerListeningUrl(line);
      if (!parsedUrl) {
        return;
      }
      finalize(() => resolve(input.resolvedUrl ?? parsedUrl));
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `Timeout waiting for ${input.config.displayName} server to start after ${timeoutMs}ms.\n${output}`,
        ),
      );
    }, timeoutMs);

    stdout.on("line", onLine);
    stderr.on("line", onLine);
    child.once("error", fail);
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      const detail = output.trim();
      fail(
        new Error(
          detail.length > 0
            ? `${input.config.displayName} server exited with code ${code ?? "null"}.\n${detail}`
            : `${input.config.displayName} server exited with code ${code ?? "null"}.`,
        ),
      );
    });
  });
}

async function startLocalOpencodeServer(
  config: ManagedServerConfig,
  binaryPath: string,
): Promise<RunningManagedServer> {
  const child = spawn(binaryPath, ["serve", `--hostname=${LOCAL_HOST}`, "--port=0"], {
    env: {
      ...process.env,
      [config.configContentEnvKey]: JSON.stringify({}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  const url = await waitForOpencodeServer(child, LOCAL_OPENCODE_START_TIMEOUT_MS, {
    config,
    binaryPath,
    executionTargetId: LOCAL_EXECUTION_TARGET_ID,
  });
  return {
    url,
    isRunning: () => child.exitCode === null && child.signalCode === null && !child.killed,
    close: () => stopSpawnedChildAndWait(child),
  };
}

async function startRemoteOpencodeServer(
  config: ManagedServerConfig,
  executionTargetId: string,
  binaryPath: string,
): Promise<RunningManagedServer> {
  assertSshExecutionTargetReady(executionTargetId);
  const localPort = await allocateLocalPort();
  const localUrl = `http://${LOCAL_HOST}:${localPort}`;
  const invocation = buildSshCommandInvocation({
    executionTargetId,
    cwd: "",
    command: binaryPath,
    args: ["serve", `--hostname=${LOCAL_HOST}`, `--port=${REMOTE_OPENCODE_PORT}`],
    transportArgs: [
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `${localPort}:${LOCAL_HOST}:${REMOTE_OPENCODE_PORT}`,
    ],
  });

  const child = spawn(invocation.command, invocation.args, {
    env: {
      ...process.env,
      [config.configContentEnvKey]: JSON.stringify({}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  await waitForOpencodeServer(child, REMOTE_OPENCODE_START_TIMEOUT_MS, {
    config,
    binaryPath,
    executionTargetId,
    resolvedUrl: localUrl,
  });
  return {
    url: localUrl,
    isRunning: () => child.exitCode === null && child.signalCode === null && !child.killed,
    close: () => stopSpawnedChildAndWait(child),
  };
}

export interface OpencodeServerManagerFactoryOptions {
  readonly startServer?: (input: {
    readonly config: ManagedServerConfig;
    readonly executionTargetId: string;
    readonly binaryPath: string;
  }) => Promise<RunningManagedServer>;
}

export function makeOpencodeServerManager(options: OpencodeServerManagerFactoryOptions = {}): {
  acquire: (input?: OpencodeServerAcquireInput) => Promise<OpencodeServerHandle>;
  closeAll: () => Promise<void>;
} {
  const states = new Map<string, TargetState>();
  const allStates = new Set<TargetState>();
  let closing = false;

  const readState = (targetKey: string, targetIdentity: string): TargetState => {
    const existing = states.get(targetKey);
    if (existing && !existing.invalidated) {
      return existing;
    }
    const initial: TargetState = {
      targetKey,
      targetIdentity,
      refCount: 0,
      invalidated: false,
      closed: false,
      startPromise: null,
      serverHandle: null,
    };
    states.set(targetKey, initial);
    allStates.add(initial);
    return initial;
  };

  const closeState = async (
    state: TargetState,
    pendingServer?: RunningManagedServer,
  ): Promise<void> => {
    if (state.closed) return;
    state.closed = true;
    const server = pendingServer ?? state.serverHandle;
    state.serverHandle = null;
    state.startPromise = null;
    state.refCount = 0;
    if (states.get(state.targetKey) === state) states.delete(state.targetKey);
    allStates.delete(state);
    await server?.close();
  };

  const invalidateState = (state: TargetState): void => {
    state.invalidated = true;
    if (states.get(state.targetKey) === state) states.delete(state.targetKey);
    if (state.refCount === 0 && state.startPromise === null) void closeState(state);
  };

  const acquire = async (input?: OpencodeServerAcquireInput): Promise<OpencodeServerHandle> => {
    if (closing) throw new Error("OpenCode server manager is shutting down.");
    const config = SERVER_CONFIGS[input?.provider ?? "opencode"];
    const executionTargetId = resolveExecutionTargetId(input?.executionTargetId);
    const binaryPath = resolveBinaryPath(config, input?.binaryPath);
    const targetKey = JSON.stringify([config.provider, executionTargetId, binaryPath]);
    const targetIdentity = JSON.stringify([config.provider, executionTargetId]);
    for (const previousState of allStates) {
      if (
        previousState.targetIdentity === targetIdentity &&
        previousState.targetKey !== targetKey
      ) {
        invalidateState(previousState);
      }
    }
    let state = readState(targetKey, targetIdentity);

    if (state.serverHandle !== null) {
      if (state.serverHandle.isRunning?.() === false) {
        invalidateState(state);
        state = readState(targetKey, targetIdentity);
      } else {
        state.refCount += 1;
        return makeHandle(state.serverHandle, input?.directory, state, config);
      }
    }

    if (state.startPromise === null) {
      state.startPromise = Promise.resolve()
        .then(() => {
          if (options.startServer) {
            return options.startServer({ config, executionTargetId, binaryPath });
          }
          return executionTargetId === LOCAL_EXECUTION_TARGET_ID
            ? startLocalOpencodeServer(config, binaryPath)
            : startRemoteOpencodeServer(config, executionTargetId, binaryPath);
        })
        .catch((error) => {
          state.startPromise = null;
          if (states.get(targetKey) === state) states.delete(targetKey);
          allStates.delete(state);
          throw error;
        });
    }

    const serverHandle = await state.startPromise;
    if (closing || state.invalidated) {
      await closeState(state, serverHandle);
      throw new Error(`${config.displayName} server start was superseded.`);
    }
    state.serverHandle = serverHandle;
    state.startPromise = null;
    state.refCount += 1;
    return makeHandle(serverHandle, input?.directory, state, config);
  };
  const makeHandle = (
    serverHandle: RunningManagedServer,
    directory: string | undefined,
    state: TargetState,
    config: ManagedServerConfig,
  ): OpencodeServerHandle => {
    let released = false;
    const client = createOpencodeClient(buildClientOptions(config, serverHandle.url, directory));

    const release = (invalidate: boolean) => {
      if (released) return;
      released = true;
      state.refCount = Math.max(0, state.refCount - 1);
      if (invalidate) invalidateState(state);
      else if (state.invalidated && state.refCount === 0) void closeState(state);
    };

    return {
      client,
      url: serverHandle.url,
      release: () => release(false),
      invalidate: () => release(true),
    };
  };

  const closeAll = async (): Promise<void> => {
    closing = true;
    await Promise.all(
      Array.from(allStates, async (state) => {
        const server =
          state.serverHandle ??
          (state.startPromise ? await state.startPromise.catch(() => null) : null);
        await closeState(state, server ?? undefined);
      }),
    );
    states.clear();
    allStates.clear();
  };

  return { acquire, closeAll };
}

export const OpencodeServerManagerLive = Layer.effect(
  OpencodeServerManager,
  Effect.acquireRelease(Effect.sync(makeOpencodeServerManager), (manager) =>
    Effect.promise(manager.closeAll),
  ).pipe(Effect.map(({ acquire }) => ({ acquire }))),
);
