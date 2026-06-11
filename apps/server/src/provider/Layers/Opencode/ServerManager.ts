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
import { killChildTree } from "../../../codex/codexAppServerManager.utils.ts";

interface RunningServer {
  readonly url: string;
  close(): void;
}

interface TargetState {
  refCount: number;
  startPromise: Promise<RunningServer> | null;
  serverHandle: RunningServer | null;
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
type ManagedServerConfig = (typeof SERVER_CONFIGS)[ManagedServerProvider];

function stopSpawnedChild(child: ReturnType<typeof spawn>): void {
  killChildTree(child as Parameters<typeof killChildTree>[0]);
}

export function readManagedServerListeningUrl(line: string): string | null {
  if (!/^(?:opencode|kilo) server listening\b/.test(line)) {
    return null;
  }
  const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
  return match?.[1] ?? null;
}

function resolveBinaryPath(config: ManagedServerConfig, binaryPath: string | undefined): string {
  const trimmed = binaryPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : config.defaultBinary;
}

function buildClientOptions(
  config: ManagedServerConfig,
  url: string,
  directory: string | undefined,
): Parameters<typeof createOpencodeClient>[0] {
  const base: Parameters<typeof createOpencodeClient>[0] = { baseUrl: url };
  if (!directory) return base;
  if ("directoryHeader" in config) {
    return { ...base, headers: { [config.directoryHeader]: encodeURIComponent(directory) } };
  }
  return { ...base, directory };
}

export function formatMissingOpencodeBinaryDetail(input: {
  readonly provider?: ManagedServerProvider;
  readonly binaryPath: string;
  readonly executionTargetId: string;
  readonly detail: string;
}): string | null {
  const config = SERVER_CONFIGS[input.provider ?? "opencode"];
  const normalizedDetail = input.detail.trim();
  if (
    normalizedDetail.length === 0 ||
    !(
      /exec:\s+.+:\s+not found/i.test(normalizedDetail) ||
      /\bcommand not found\b/i.test(normalizedDetail) ||
      /\bspawn\b.+\benoent\b/i.test(normalizedDetail) ||
      /\bno such file or directory\b/i.test(normalizedDetail)
    )
  ) {
    return null;
  }

  const remote = input.executionTargetId !== LOCAL_EXECUTION_TARGET_ID;
  if (input.binaryPath === config.defaultBinary) {
    return remote
      ? `Remote ${config.displayName} CLI is not installed or not available on PATH. Install '${config.defaultBinary}' on the remote host or set Providers > ${config.displayName} > Binary path to the remote executable path.`
      : `${config.displayName} CLI is not installed or not available on PATH. Install '${config.defaultBinary}' locally or set Providers > ${config.displayName} > Binary path to the local executable path.`;
  }

  return remote
    ? `Remote ${config.displayName} binary was not found at '${input.binaryPath}'. Update Providers > ${config.displayName} > Binary path to the correct remote executable path.`
    : `${config.displayName} binary was not found at '${input.binaryPath}'. Update Providers > ${config.displayName} > Binary path to the correct local executable path.`;
}

function normalizeOpencodeStartError(input: {
  readonly config: ManagedServerConfig;
  readonly binaryPath: string;
  readonly executionTargetId: string;
  readonly error: unknown;
  readonly output: string;
}): Error {
  if (input.error instanceof Error) {
    const errnoCode = "code" in input.error ? input.error.code : undefined;
    if (errnoCode === "ENOENT") {
      const missingBinaryDetail = formatMissingOpencodeBinaryDetail({
        provider: input.config.provider,
        binaryPath: input.binaryPath,
        executionTargetId: input.executionTargetId,
        detail: input.error.message,
      });
      if (missingBinaryDetail) {
        return new Error(missingBinaryDetail);
      }
    }

    const missingBinaryDetail = formatMissingOpencodeBinaryDetail({
      provider: input.config.provider,
      binaryPath: input.binaryPath,
      executionTargetId: input.executionTargetId,
      detail: `${input.error.message}\n${input.output}`,
    });
    if (missingBinaryDetail) {
      return new Error(missingBinaryDetail);
    }
    return input.error;
  }

  return new Error(`Failed to start ${input.config.displayName} server: ${String(input.error)}`);
}

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
          normalizeOpencodeStartError({
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
): Promise<RunningServer> {
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
    close() {
      stopSpawnedChild(child);
    },
  };
}

async function startRemoteOpencodeServer(
  config: ManagedServerConfig,
  executionTargetId: string,
  binaryPath: string,
): Promise<RunningServer> {
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
    close() {
      stopSpawnedChild(child);
    },
  };
}

function makeOpencodeServerManager(): {
  acquire: (input?: OpencodeServerAcquireInput) => Promise<OpencodeServerHandle>;
} {
  const states = new Map<string, TargetState>();

  const readState = (targetKey: string): TargetState => {
    const existing = states.get(targetKey);
    if (existing) {
      return existing;
    }
    const initial: TargetState = {
      refCount: 0,
      startPromise: null,
      serverHandle: null,
    };
    states.set(targetKey, initial);
    return initial;
  };

  const acquire = async (input?: OpencodeServerAcquireInput): Promise<OpencodeServerHandle> => {
    const config = SERVER_CONFIGS[input?.provider ?? "opencode"];
    const executionTargetId = resolveExecutionTargetId(input?.executionTargetId);
    const binaryPath = resolveBinaryPath(config, input?.binaryPath);
    const targetKey = JSON.stringify([config.provider, executionTargetId, binaryPath]);
    const state = readState(targetKey);

    if (state.serverHandle !== null) {
      state.refCount += 1;
      return makeHandle(state.serverHandle, input?.directory, targetKey, config);
    }

    if (state.startPromise === null) {
      state.startPromise = Promise.resolve()
        .then(() =>
          executionTargetId === LOCAL_EXECUTION_TARGET_ID
            ? startLocalOpencodeServer(config, binaryPath)
            : startRemoteOpencodeServer(config, executionTargetId, binaryPath),
        )
        .catch((error) => {
          state.startPromise = null;
          console.error(
            `[opencode-server-manager] Failed to start ${config.displayName} server for target '${targetKey}':`,
            error,
          );
          throw error;
        });
    }

    const serverHandle = await state.startPromise;
    state.serverHandle = serverHandle;
    state.startPromise = null;
    state.refCount += 1;
    return makeHandle(serverHandle, input?.directory, targetKey, config);
  };
  const makeHandle = (
    serverHandle: RunningServer,
    directory: string | undefined,
    targetKey: string,
    config: ManagedServerConfig,
  ): OpencodeServerHandle => {
    let released = false;
    const client = createOpencodeClient(buildClientOptions(config, serverHandle.url, directory));

    return {
      client,
      url: serverHandle.url,
      release() {
        if (released) {
          return;
        }
        released = true;
        const state = readState(targetKey);
        state.refCount -= 1;
        if (state.refCount <= 0 && state.serverHandle !== null) {
          state.serverHandle.close();
          state.serverHandle = null;
          state.refCount = 0;
        }
      },
    };
  };

  return { acquire };
}

export const OpencodeServerManagerLive = Layer.effect(
  OpencodeServerManager,
  Effect.sync(() => makeOpencodeServerManager()),
);
