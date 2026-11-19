import type { NativeApi, ProjectEntry } from "@bigbud/contracts";
import { inferHomeFromCwd } from "../../utils/terminal/links.utils";

/** A home-relative hook config path split into the parts the Files panel opens. */
export interface HookConfigPathParts {
  /** Folder below the home folder, e.g. `.claude`. */
  readonly relativeDirectory: string;
  readonly fileName: string;
}

export type HookConfigFileState =
  | { readonly status: "exists"; readonly directory: string; readonly fileName: string }
  | { readonly status: "missing" }
  /** The server home folder could not be confirmed, so no file is offered. */
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

/** Distinct home folders inferred from absolute paths the server reported. */
export function inferHomeCandidates(paths: ReadonlyArray<string | null | undefined>): string[] {
  const candidates: string[] = [];
  for (const path of paths) {
    const home = path ? inferHomeFromCwd(path) : undefined;
    if (home && !candidates.includes(home)) candidates.push(home);
  }
  return candidates;
}

function listingKey(entries: ReadonlyArray<ProjectEntry>): string {
  return entries
    .map((entry) => `${entry.kind}:${entry.path}`)
    .toSorted()
    .join("\n");
}

async function listOrNull(
  api: NativeApi,
  cwd: string,
  relativePath?: string,
): Promise<ReadonlyArray<ProjectEntry> | null> {
  try {
    const result = await api.projects.listDirectory({
      cwd,
      ...(relativePath ? { relativePath } : {}),
    });
    return result.entries;
  } catch {
    return null;
  }
}

/**
 * The server expands `~` only when listing, while previews need an absolute root. A candidate is
 * accepted only when its listing matches the server's own `~` listing.
 */
export async function resolveServerHome(
  api: NativeApi,
  candidates: ReadonlyArray<string>,
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const home = await listOrNull(api, "~");
  if (home === null) return null;
  const expected = listingKey(home);
  for (const candidate of candidates) {
    const listing = await listOrNull(api, candidate);
    if (listing !== null && listingKey(listing) === expected) return candidate;
  }
  return null;
}

/** Whether a home-relative config file exists on the local server host; never writes. */
export async function resolveHookConfigFile(
  api: NativeApi,
  configPath: string,
  homeCandidates: ReadonlyArray<string>,
): Promise<HookConfigFileState> {
  const parts = splitHomeConfigPath(configPath);
  if (!parts) return { status: "unavailable" };
  const home = await resolveServerHome(api, homeCandidates);
  if (!home) return { status: "unavailable" };
  const separator = home.includes("\\") ? "\\" : "/";
  const directory = `${home}${separator}${parts.relativeDirectory.replaceAll("/", separator)}`;
  const entries = await listOrNull(api, directory);
  const exists = entries?.some((entry) => entry.kind === "file" && entry.path === parts.fileName);
  return exists ? { status: "exists", directory, fileName: parts.fileName } : { status: "missing" };
}
