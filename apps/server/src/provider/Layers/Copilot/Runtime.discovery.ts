import { execFile } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import Path from "node:path";
import { promisify } from "node:util";
import type { CopilotRuntimeInstallation } from "@bigbud/contracts/server/copilotRuntime";
import { resolveCopilotRuntimeInvocation } from "./Adapter.types.cli.ts";
import {
  readManagedCopilotVersion,
  readManagedCopilotRuntime,
} from "@bigbud/shared/copilotRuntime.paths";
import { resolveCopilotRuntimeRelease } from "./Runtime.release.ts";
import { sdkCopilotExecutable } from "./Runtime.executable.ts";
import { resolveNodeExecutable } from "../../../utils/nodeExecutable.ts";

const probes = new Map<string, { stamp: string; until: number; value: Promise<string | null> }>();
function probeVersion(path: string, stamp: string, sdk: boolean): Promise<string | null> {
  const cached = probes.get(path);
  if (cached?.stamp === stamp && cached.until > Date.now()) return cached.value;
  const value = promisify(execFile)(
    path.endsWith(".js") ? resolveNodeExecutable() : path,
    path.endsWith(".js") ? [path, "--version"] : ["--version"],
    { timeout: 5_000, maxBuffer: 16_384, windowsHide: true, env: process.env },
  )
    .then((result) => /\b\d+\.\d+\.\d+\b/.exec(result.stdout)?.[0] ?? null)
    .catch((error) => {
      if (!sdk) throw error;
      return null;
    });
  if (probes.size >= 32) probes.clear();
  probes.set(path, { stamp, until: Date.now() + 30_000, value });
  return value;
}

let musl: boolean | undefined;
export function localCopilotRelease() {
  if (musl === undefined) {
    const report =
      process.platform === "linux"
        ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
        : undefined;
    musl = process.platform === "linux" && !report?.header?.glibcVersionRuntime;
  }
  return resolveCopilotRuntimeRelease({
    platform: process.platform,
    arch: process.arch,
    isMusl: musl,
  });
}

export async function runtimeInstalledSize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = Path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await runtimeInstalledSize(path);
    else if (entry.isFile()) bytes += (await lstat(path)).size;
    else throw new Error("Refusing a managed runtime containing symlinks or special files.");
  }
  return bytes;
}

/** Enumerate only marked version/target directories. Unknown content is never owned implicitly. */
export async function managedCopilotInstallations(
  root: string,
): Promise<CopilotRuntimeInstallation[]> {
  const installed: CopilotRuntimeInstallation[] = [];
  for (const version of await readdir(root, { withFileTypes: true })) {
    if (!/^\d+\.\d+\.\d+$/.test(version.name)) continue;
    if (!version.isDirectory()) throw new Error("Unsafe Copilot version directory.");
    for (const target of await readdir(Path.join(root, version.name), { withFileTypes: true })) {
      if (!target.isDirectory()) throw new Error("Unsafe Copilot target directory.");
      const runtime = readManagedCopilotVersion(root, `${version.name}/${target.name}`);
      if (!runtime)
        throw new Error("Unrecognized Copilot installation; refusing managed deletion.");
      installed.push({ ...runtime, sizeBytes: await runtimeInstalledSize(runtime.directory) });
    }
  }
  return installed;
}

/** Auth-free discovery. No downloads, cache materialization, provider enabling, or session creation. */
export async function discoverCopilotRuntime(binaryPath: string, root: string) {
  let invocation: ReturnType<typeof resolveCopilotRuntimeInvocation>;
  try {
    invocation = resolveCopilotRuntimeInvocation(binaryPath, {
      managedRoot: root,
      isElectron: true,
    });
  } catch {
    /* The SDK-native package is a usable legacy source even without the standalone CLI. */
  }
  let path = invocation?.path;
  let source: "configured" | "managed" | "bundled-native" | "existing" | "sdk" | "missing" =
    invocation?.source ?? "missing";
  if (!path && binaryPath === "copilot") {
    try {
      path = sdkCopilotExecutable(localCopilotRelease().target);
      if (path) source = "sdk";
    } catch {
      /* Unsupported platform. */
    }
  }
  if (!path)
    return {
      available: false,
      source,
      path: null,
      version: null,
      installedSizeBytes: null,
      error: null,
    };
  try {
    const file = await (source === "configured" || source === "existing"
      ? stat(path)
      : lstat(path));
    if (!file.isFile()) throw new Error("Copilot executable is not a regular file.");
    const version =
      source === "managed"
        ? (readManagedCopilotRuntime(root)?.version ?? null)
        : await probeVersion(path, `${file.mtimeMs}:${file.size}`, source === "sdk");
    return {
      available: true,
      source,
      path,
      version,
      installedSizeBytes:
        source === "bundled-native" || source === "sdk" || source === "managed"
          ? await runtimeInstalledSize(
              Path.resolve(
                Path.dirname(path),
                source === "sdk" ? "../.." : source === "managed" ? ".." : ".",
              ),
            )
          : null,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      source,
      path,
      version: null,
      installedSizeBytes: null,
      error: `Could not execute Copilot: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
