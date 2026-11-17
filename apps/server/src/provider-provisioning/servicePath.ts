/**
 * Service PATH discovery (P7 increment 5, WP-5B).
 *
 * The remote backend runs as a systemd user service started by the Rust supervisor with a
 * cleared environment: HOME, LANG and PATH = <private node dir>:/usr/local/bin:/usr/bin:/bin,
 * and no SHELL. User-installed provider CLIs (nvm, Homebrew, ~/.local/bin…) are therefore not
 * on PATH. WP-5C calls `discoverServicePath()` once per provisioning/readiness pass and passes
 * the result to `resolveProviderExecutable()`; the service's own process.env is never mutated.
 *
 * Precedence, highest first:
 *   1. explicit configured paths: a provider's configured binary path is used as-is and never
 *      replaced; configured extra PATH directories come before everything discovered;
 *   2. the login shell's PATH (`$SHELL -lc`, bounded, no TTY; shell from SHELL, else the
 *      account's passwd shell, else the platform default);
 *   3. known version-manager directories (nvm, fnm, volta, asdf, mise, pyenv, cargo,
 *      ~/.local/bin, Homebrew/Linuxbrew), which covers non-interactive shells that skip
 *      ~/.bashrc;
 *   4. the inherited process PATH.
 */
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { listLoginShellCandidates } from "@bigbud/shared/shell";
import * as Effect from "effect/Effect";

import {
  listVersionManagerDirs,
  VERSION_MANAGER_ENV_NAMES,
  type VersionManager,
} from "./servicePath.dirs.ts";
import { captureLoginShellEnvironment, type LoginShellCapture } from "./servicePath.shell.ts";

export type ServicePathSource = "explicit" | "loginShell" | "versionManager" | "inherited";

export interface ServicePathEntry {
  readonly dir: string;
  readonly source: ServicePathSource;
  readonly manager?: VersionManager;
}

export type ServicePathShellResult = LoginShellCapture | { readonly status: "skipped" };

export interface ServicePathDiscovery {
  /** Colon-joined PATH for spawning provider processes. */
  readonly path: string;
  readonly entries: ReadonlyArray<ServicePathEntry>;
  readonly shell: ServicePathShellResult;
}

export interface DiscoverServicePathOptions {
  /** Configured extra PATH directories; always first. */
  readonly explicitDirs?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  /** Overrides shell selection; `null` skips the login-shell capture. */
  readonly shell?: string | null;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

function accountShell(): string | undefined {
  try {
    return OS.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function splitPath(value: string | undefined): ReadonlyArray<string> {
  return value ? value.split(Path.delimiter).filter((entry) => Path.isAbsolute(entry)) : [];
}

const captureFirstShell = Effect.fn("captureFirstShell")(function* (
  shells: ReadonlyArray<string>,
  input: { env: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
) {
  let last: ServicePathShellResult = { status: "skipped" };
  for (const shell of shells) {
    last = yield* captureLoginShellEnvironment({
      shell,
      names: ["PATH", ...VERSION_MANAGER_ENV_NAMES],
      env: input.env,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });
    // A slow or noisy profile is not retried with another shell: bounds stay per discovery.
    if (last.status !== "failed") return last;
  }
  return last;
});

export const discoverServicePath = Effect.fn("discoverServicePath")(function* (
  options: DiscoverServicePathOptions = {},
) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? OS.homedir();

  let shell: ServicePathShellResult = { status: "skipped" };
  if (platform !== "win32" && options.shell !== null) {
    const shells =
      options.shell !== undefined
        ? [options.shell]
        : listLoginShellCandidates(platform, env.SHELL, accountShell());
    shell = yield* captureFirstShell(shells, {
      env: { ...env, HOME: home },
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    });
  }
  const captured = shell.status === "captured" ? shell.environment : {};
  const managerEnv = Object.fromEntries(
    VERSION_MANAGER_ENV_NAMES.map((name) => [name, captured[name] ?? env[name]]),
  );
  const managerDirs = yield* Effect.promise(() =>
    listVersionManagerDirs({ home, platform, env: managerEnv }),
  );

  const entries: ServicePathEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: ServicePathEntry) => {
    if (seen.has(entry.dir)) return;
    seen.add(entry.dir);
    entries.push(entry);
  };
  for (const dir of options.explicitDirs ?? []) {
    if (Path.isAbsolute(dir)) push({ dir, source: "explicit" });
  }
  for (const dir of splitPath(captured.PATH)) push({ dir, source: "loginShell" });
  for (const { dir, manager } of managerDirs) push({ dir, source: "versionManager", manager });
  for (const dir of splitPath(env.PATH)) push({ dir, source: "inherited" });

  return {
    path: entries.map((entry) => entry.dir).join(Path.delimiter),
    entries,
    shell,
  } satisfies ServicePathDiscovery;
});

export type ProviderExecutableResolution =
  | { readonly source: "explicit"; readonly path: string }
  | { readonly source: "discovered"; readonly path: string; readonly entry: ServicePathEntry }
  | { readonly source: "missing"; readonly searched: ReadonlyArray<string> };

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit configured paths always win: a configured value containing a path separator is
 * returned untouched (even if it does not exist yet, so readiness reports it, not discovery).
 * A configured bare command name is searched before the recipe's default names.
 */
export const resolveProviderExecutable = Effect.fn("resolveProviderExecutable")(function* (input: {
  readonly configuredPath?: string | undefined;
  readonly commandNames: ReadonlyArray<string>;
  readonly discovery: ServicePathDiscovery;
}) {
  const configured = input.configuredPath?.trim();
  if (configured && (configured.includes("/") || configured.includes("\\"))) {
    return { source: "explicit", path: configured } satisfies ProviderExecutableResolution;
  }
  const names = [...new Set([...(configured ? [configured] : []), ...input.commandNames])];
  for (const entry of input.discovery.entries) {
    for (const name of names) {
      const candidate = Path.join(entry.dir, name);
      if (yield* Effect.promise(() => isExecutableFile(candidate))) {
        return {
          source: "discovered",
          path: candidate,
          entry,
        } satisfies ProviderExecutableResolution;
      }
    }
  }
  return { source: "missing", searched: names } satisfies ProviderExecutableResolution;
});
