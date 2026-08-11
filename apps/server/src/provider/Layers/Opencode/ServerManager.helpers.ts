import { spawn } from "node:child_process";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { killChildTree } from "../../../codex/codexAppServerManager.utils.ts";

import type { ManagedServerConfig } from "./ServerManager.ts";

export function stopSpawnedChild(child: ReturnType<typeof spawn>): void {
  killChildTree(child as Parameters<typeof killChildTree>[0]);
}

export async function stopSpawnedChildAndWait(
  child: ReturnType<typeof spawn>,
  timeoutMs = 1_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(giveUpTimer);
      child.off("exit", settle);
      resolve();
    };
    const forceKillTimer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const giveUpTimer = setTimeout(settle, timeoutMs + 500);
    child.once("exit", settle);
    stopSpawnedChild(child);
  });
}

export function readManagedServerListeningUrl(line: string): string | null {
  if (!/^(?:opencode|kilo) server listening\b/.test(line)) {
    return null;
  }
  const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
  return match?.[1] ?? null;
}

export function resolveBinaryPath(
  config: ManagedServerConfig,
  binaryPath: string | undefined,
): string {
  const trimmed = binaryPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : config.defaultBinary;
}

export function buildClientOptions(
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
