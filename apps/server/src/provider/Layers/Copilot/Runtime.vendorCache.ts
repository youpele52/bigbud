import Path from "node:path";
import { copilotRuntimeRoot } from "@bigbud/shared/copilotRuntime.paths";
import { runtimeDirectory } from "@bigbud/shared/copilotRuntime.storage";
import type { CopilotRuntimeInvocation } from "./Adapter.types.cli.ts";

/**
 * The `@github/copilot-<target>` CLI is a self-extracting executable: every launch materializes its
 * ~200 MB package under `$COPILOT_PKG_CACHE_HOME/pkg` (default `~/.cache/copilot/pkg`) with
 * umask-dependent modes, i.e. world-writable under umask 000. Copies bigbud ships or manages are
 * pointed at a 0700 bigbud-owned parent so that tree is unreachable for other local users.
 * External/configured installs and explicit user cache overrides keep the vendor default.
 */
export function copilotVendorCacheDirectory(root = copilotRuntimeRoot()): string {
  return Path.join(root, ".vendor-cache");
}

function ownsVendorCache(source: CopilotRuntimeInvocation["source"], env: NodeJS.ProcessEnv) {
  return (
    process.platform !== "win32" &&
    (source === "bundled-native" || source === "managed") &&
    env.COPILOT_PKG_CACHE_HOME === undefined &&
    env.COPILOT_CACHE_HOME === undefined
  );
}

/** Pure: the full child environment for an owned CLI, or undefined to inherit unchanged. */
export function copilotRuntimeEnvironment(
  invocation: Pick<CopilotRuntimeInvocation, "source">,
  env: NodeJS.ProcessEnv = process.env,
  root = copilotRuntimeRoot(),
): Record<string, string> | undefined {
  if (!ownsVendorCache(invocation.source, env)) return undefined;
  const inherited = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return {
    ...Object.fromEntries(inherited),
    COPILOT_PKG_CACHE_HOME: copilotVendorCacheDirectory(root),
  };
}

/** Call before launching a Copilot client; the vendor would otherwise create the parent itself. */
export async function prepareCopilotVendorCache(root = copilotRuntimeRoot()): Promise<void> {
  if (process.platform === "win32") return;
  await runtimeDirectory(copilotVendorCacheDirectory(root));
}
