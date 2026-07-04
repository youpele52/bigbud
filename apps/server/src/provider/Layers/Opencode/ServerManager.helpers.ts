import { spawn } from "node:child_process";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import { killChildTree } from "../../../codex/codexAppServerManager.utils.ts";

import type { ManagedServerConfig } from "./ServerManager.ts";

export function stopSpawnedChild(child: ReturnType<typeof spawn>): void {
  killChildTree(child as Parameters<typeof killChildTree>[0]);
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
