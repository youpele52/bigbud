/**
 * Known user tool directories (version managers, ~/.local/bin, Homebrew/Linuxbrew).
 *
 * Non-interactive login shells often miss these: Ubuntu's ~/.bashrc returns early when not
 * interactive, and nvm/fnm initialise there. Discovery therefore inspects the layouts directly.
 * Only existing directories are returned; nothing here executes user code.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import * as Path from "node:path";

export type VersionManager =
  | "nvm"
  | "fnm"
  | "volta"
  | "asdf"
  | "mise"
  | "pyenv"
  | "cargo"
  | "local"
  | "homebrew";

export interface VersionManagerDir {
  readonly dir: string;
  readonly manager: VersionManager;
}

/** Variables read from the captured login environment (service env is usually cleared). */
export const VERSION_MANAGER_ENV_NAMES = [
  "NVM_DIR",
  "FNM_DIR",
  "VOLTA_HOME",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "PYENV_ROOT",
  "CARGO_HOME",
  "XDG_DATA_HOME",
] as const;

type ManagerEnv = Partial<Record<(typeof VERSION_MANAGER_ENV_NAMES)[number], string>>;

const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const MAX_NVM_ALIAS_HOPS = 4;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function compareNodeVersionsDescending(left: string, right: string): number {
  const a = NODE_VERSION_PATTERN.exec(left);
  const b = NODE_VERSION_PATTERN.exec(right);
  if (!a || !b) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(b[index]) - Number(a[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Picks the installed version an nvm alias points at (`22`, `v22.1.0`, `node`, `lts/iron`). */
async function resolveNvmDefault(
  nvmDir: string,
  installed: ReadonlyArray<string>,
): Promise<string | undefined> {
  let alias = "default";
  for (let hop = 0; hop < MAX_NVM_ALIAS_HOPS; hop += 1) {
    let value: string;
    try {
      value = (await readFile(Path.join(nvmDir, "alias", alias), "utf8")).trim();
    } catch {
      return undefined;
    }
    if (value === "node" || value === "stable") return installed[0];
    const prefix = value.startsWith("v") ? value.slice(1) : value;
    if (/^\d+(\.\d+){0,2}$/.test(prefix)) {
      return installed.find((version) => {
        const bare = version.slice(1);
        return bare === prefix || bare.startsWith(`${prefix}.`);
      });
    }
    if (value.includes("..") || value.startsWith("/")) return undefined;
    alias = value;
  }
  return undefined;
}

/** nvm: the default alias first, then every other installed version newest first. */
export async function nvmBinDirs(nvmDir: string): Promise<ReadonlyArray<string>> {
  let installed: string[];
  try {
    installed = (await readdir(Path.join(nvmDir, "versions", "node")))
      .filter((name) => NODE_VERSION_PATTERN.test(name))
      .toSorted(compareNodeVersionsDescending);
  } catch {
    return [];
  }
  const preferred = await resolveNvmDefault(nvmDir, installed);
  const ordered = preferred
    ? [preferred, ...installed.filter((version) => version !== preferred)]
    : installed;
  return ordered.map((version) => Path.join(nvmDir, "versions", "node", version, "bin"));
}

/** Candidate directories in priority order, before existence filtering. */
export async function versionManagerCandidates(input: {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: ManagerEnv;
}): Promise<ReadonlyArray<VersionManagerDir>> {
  const { home, platform, env } = input;
  const dataHome = env.XDG_DATA_HOME || Path.join(home, ".local", "share");
  const candidates: VersionManagerDir[] = [];
  const add = (manager: VersionManager, ...dirs: ReadonlyArray<string>) => {
    for (const dir of dirs) candidates.push({ dir, manager });
  };

  add("nvm", ...(await nvmBinDirs(env.NVM_DIR || Path.join(home, ".nvm"))));
  const fnmRoots = env.FNM_DIR
    ? [env.FNM_DIR]
    : [
        Path.join(dataHome, "fnm"),
        ...(platform === "darwin"
          ? [Path.join(home, "Library", "Application Support", "fnm")]
          : []),
        Path.join(home, ".fnm"),
      ];
  add("fnm", ...fnmRoots.map((root) => Path.join(root, "aliases", "default", "bin")));
  add("volta", Path.join(env.VOLTA_HOME || Path.join(home, ".volta"), "bin"));
  add("asdf", Path.join(env.ASDF_DATA_DIR || Path.join(home, ".asdf"), "shims"));
  add("mise", Path.join(env.MISE_DATA_DIR || Path.join(dataHome, "mise"), "shims"));
  const pyenvRoot = env.PYENV_ROOT || Path.join(home, ".pyenv");
  add("pyenv", Path.join(pyenvRoot, "shims"), Path.join(pyenvRoot, "bin"));
  add("cargo", Path.join(env.CARGO_HOME || Path.join(home, ".cargo"), "bin"));
  add("local", Path.join(home, ".local", "bin"));
  if (platform === "darwin") add("homebrew", "/opt/homebrew/bin", "/usr/local/bin");
  if (platform === "linux") {
    add("homebrew", "/home/linuxbrew/.linuxbrew/bin", Path.join(home, ".linuxbrew", "bin"));
  }
  return candidates;
}

/** Existing version-manager directories in priority order. */
export async function listVersionManagerDirs(input: {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: ManagerEnv;
}): Promise<ReadonlyArray<VersionManagerDir>> {
  const candidates = await versionManagerCandidates(input);
  const present = await Promise.all(candidates.map((entry) => isDirectory(entry.dir)));
  return candidates.filter((_, index) => present[index]);
}
