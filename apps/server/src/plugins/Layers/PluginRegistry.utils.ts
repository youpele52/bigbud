import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { PluginCatalogItem, PluginInstallation, PluginSyncState } from "@bigbud/contracts";

const execFileAsync = promisify(execFile);

export type StoredPluginSnapshot = {
  readonly commit: string;
  readonly items: ReadonlyArray<PluginCatalogItem>;
  readonly syncedAt: string;
};
export type StoredPluginInstallation = PluginInstallation & { readonly item?: PluginCatalogItem };
export type StoredPluginRegistry = {
  readonly installations: ReadonlyArray<StoredPluginInstallation>;
};
export const emptyPluginSync = (
  status: PluginSyncState["status"],
  failure?: string,
): PluginSyncState => ({
  status,
  ...(failure ? { failure } : {}),
});

export function retainInstalledPluginMetadata(
  next: StoredPluginRegistry,
  prior: StoredPluginRegistry,
): StoredPluginRegistry {
  return {
    installations: next.installations.map((installation) => {
      if (installation.item) return installation;
      const item = prior.installations.find(
        (entry) => entry.pluginId === installation.pluginId,
      )?.item;
      return item ? { ...installation, item } : installation;
    }),
  };
}

export const safeJson = async <A>(file: string, fallback: A): Promise<A> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as A;
  } catch {
    return fallback;
  }
};

export function pluginFailureCategory(cause: unknown): string {
  const message = cause instanceof Error ? cause.message.toLowerCase() : "unknown";
  if (message.includes("git")) return "git";
  if (message.includes("enospc")) return "disk";
  if (message.includes("eacces")) return "permission";
  return "unavailable";
}

export function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.includes("../") && !path.includes("..\\"));
}

export function marketplaceEntries(input: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(input)) return input.filter(isRecord);
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const entries = record.plugins ?? record.items;
  return Array.isArray(entries) ? entries.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export async function runGit(args: ReadonlyArray<string>, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (cause) {
    const stderr =
      cause && typeof cause === "object" && "stderr" in cause && typeof cause.stderr === "string"
        ? cause.stderr
        : "";
    throw new Error(`git command failed: ${stderr.slice(0, 160)}`, { cause });
  }
}
