import * as fs from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import type { RemoteAgentControl } from "../remote-agent/remoteAgentControl.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import { hasRemoteAgentPathControls } from "../remote-agent/remoteAgentRuntime.ts";
import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
} from "../remote-agent/remoteAgentUpdate.inventory.ts";
import type { ProcessRunOptions, ProcessRunResult } from "../utils/processRunner.ts";
import { runLocalSupervisorCommand } from "./localSupervisorControl.runner.ts";

const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export interface LocalSupervisorCommandOptions {
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export interface LocalSupervisorControl {
  readonly targetId: string;
  readonly homeDir: string;
  readonly root: string;
  readonly openControl: (target: string) => Promise<RemoteAgentControl>;
  readonly run: (
    target: string,
    script: string,
    options?: LocalSupervisorCommandOptions,
  ) => Promise<ProcessRunResult>;
}

function bounded(value: number | undefined, maximum: number): number {
  const selected = value ?? maximum;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum)
    throw new Error("Local supervisor command limits exceed the bounded control policy.");
  return selected;
}

/** Account-scoped GNU command transport. Script strings are trusted internal builders, never RPC input. */
export function makeLocalSupervisorControl(input: {
  readonly targetId: string;
  readonly homeDir: string;
  /** Trusted test seam; production always uses the bounded process runner. */
  readonly execute?: (
    command: string,
    args: ReadonlyArray<string>,
    options: ProcessRunOptions,
  ) => Promise<ProcessRunResult>;
}): LocalSupervisorControl {
  if (!/^remote-backend:[a-f0-9]{32}$/.test(input.targetId))
    throw new Error("Local supervisor control requires an exact backend authority target.");
  const homeDir = input.homeDir;
  if (!isAbsolute(homeDir) || normalize(homeDir) !== homeDir || hasRemoteAgentPathControls(homeDir))
    throw new Error("Local supervisor home must be an absolute canonical account directory.");
  const root = join(homeDir, ".bigbud", "agent");
  const execute = input.execute ?? runLocalSupervisorCommand;
  let rootIdentity: { dev: bigint; ino: bigint } | undefined;
  let preparing: Promise<void> | undefined;
  const assertTarget = (target: string) => {
    if (target !== input.targetId)
      throw new Error("Local supervisor control cannot address another authority or SSH target.");
  };
  const inspect = async (path: string, mode: "home" | "shared-parent" | "private") => {
    const stat = await fs.lstat(path, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.uid !== BigInt(process.getuid?.() ?? -1) ||
      (mode === "home" && (stat.mode & 0o022n) !== 0n) ||
      (mode === "shared-parent" && ![0o700n, 0o755n].includes(stat.mode & 0o7777n)) ||
      (mode === "private" && (stat.mode & 0o7777n) !== 0o700n) ||
      (await fs.realpath(path)) !== path
    )
      throw new Error("Local supervisor state requires canonical owned private directories.");
    return stat;
  };
  const prepare = async () => {
    await inspect(homeDir, "home");
    const paths = [join(homeDir, ".bigbud"), root];
    if (rootIdentity) {
      const existing = await inspect(root, "private");
      if (existing.dev !== rootIdentity.dev || existing.ino !== rootIdentity.ino)
        throw new Error("The local supervisor control root was replaced; preserve it for repair.");
    }
    // Inspect all existing descendants before creating anything under an unsafe tree.
    for (const path of paths) {
      try {
        await inspect(path, path === root ? "private" : "shared-parent");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const path of paths) {
      try {
        await fs.mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await inspect(path, path === root ? "private" : "shared-parent");
    }
    const stat = await inspect(root, "private");
    if (rootIdentity && (stat.dev !== rootIdentity.dev || stat.ino !== rootIdentity.ino))
      throw new Error("The local supervisor control root was replaced; preserve it for repair.");
    rootIdentity = { dev: stat.dev, ino: stat.ino };
  };
  const ensure = async () => {
    preparing ??= prepare().finally(() => {
      preparing = undefined;
    });
    await preparing;
  };
  const run: LocalSupervisorControl["run"] = async (target, script, options = {}) => {
    assertTarget(target);
    const timeoutMs = bounded(options.timeoutMs, MAX_TIMEOUT_MS);
    const maxBufferBytes = bounded(options.maxBufferBytes, MAX_OUTPUT_BYTES);
    options.signal?.throwIfAborted();
    await ensure();
    return execute("/bin/sh", ["-c", script], {
      cwd: homeDir,
      env: { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      shell: false,
      settleOnTimeout: true,
      outputMode: "error",
      timeoutMs,
      maxBufferBytes,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };
  const openControl: LocalSupervisorControl["openControl"] = async (target) => {
    assertTarget(target);
    await ensure();
    const command = { run: async (script: string) => (await run(target, script)).stdout };
    return {
      root,
      run: command.run,
      registry: makeRemoteAgentRegistryStore(root, command),
      inventory: async () =>
        parseRemoteAgentInventory(await command.run(buildRemoteAgentInventoryCommand(root))),
    };
  };
  return { targetId: input.targetId, homeDir, root, openControl, run };
}
