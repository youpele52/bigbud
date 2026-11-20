import type { NativeApi } from "@bigbud/contracts";

/** A home-relative hook config path split into the parts the Files panel opens. */
export interface HookConfigPathParts {
  /** Folder below the home folder, e.g. `.claude`. */
  readonly relativeDirectory: string;
  readonly fileName: string;
}

/** Absolute location of a hook config file on the server host. */
export interface HookConfigFileLocation {
  readonly directory: string;
  readonly fileName: string;
}

export type HookConfigFileState =
  | ({ readonly status: "exists" } & HookConfigFileLocation)
  | ({ readonly status: "missing" } & HookConfigFileLocation)
  /** The server did not report its home folder, so no file is offered. */
  | { readonly status: "unavailable" };

/** Splits `~/dir/file` into its home-relative folder and file name; null for anything else. */
export function splitHomeConfigPath(configPath: string): HookConfigPathParts | null {
  if (!configPath.startsWith("~/")) return null;
  const segments = configPath.slice(2).split("/");
  const fileName = segments.pop();
  if (!fileName || segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    return null;
  }
  return { relativeDirectory: segments.join("/"), fileName };
}

function hookConfigLocation(homeDir: string, parts: HookConfigPathParts): HookConfigFileLocation {
  const separator = homeDir.includes("\\") ? "\\" : "/";
  const home = homeDir.endsWith(separator) ? homeDir.slice(0, -1) : homeDir;
  return {
    directory: `${home}${separator}${parts.relativeDirectory.replaceAll("/", separator)}`,
    fileName: parts.fileName,
  };
}

/** Whether a home-relative config file exists on the server host; never writes. */
export async function resolveHookConfigFile(
  api: NativeApi,
  configPath: string,
  homeDir: string | undefined,
): Promise<HookConfigFileState> {
  const parts = splitHomeConfigPath(configPath);
  if (!parts || !homeDir) return { status: "unavailable" };
  const location = hookConfigLocation(homeDir, parts);
  const entries = await api.projects
    .listDirectory({ cwd: location.directory })
    .then((result) => result.entries)
    .catch(() => null);
  const exists = entries?.some(
    (entry) => entry.kind === "file" && entry.path === location.fileName,
  );
  return { status: exists ? "exists" : "missing", ...location };
}

function isAlreadyExistsError(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "alreadyExists" in cause &&
    cause.alreadyExists === true
  );
}

/**
 * Creates a missing config file with `contents` (exclusive create, parents included) and returns
 * where it is. A file that appeared meanwhile is kept as is and returned; nothing is overwritten.
 */
export async function createHookConfigFile(
  api: NativeApi,
  configPath: string,
  homeDir: string,
  contents: string,
): Promise<HookConfigFileLocation> {
  const parts = splitHomeConfigPath(configPath);
  if (!parts) throw new Error(`${configPath} is not inside the home folder.`);
  try {
    await api.projects.writeFile({
      cwd: homeDir,
      relativePath: `${parts.relativeDirectory}/${parts.fileName}`,
      contents,
      createOnly: true,
    });
  } catch (cause) {
    if (!isAlreadyExistsError(cause)) throw cause;
  }
  return hookConfigLocation(homeDir, parts);
}
