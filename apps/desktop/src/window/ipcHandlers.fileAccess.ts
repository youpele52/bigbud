/**
 * The File Access probe. Choosing a level (first-launch question or Settings) is the one moment
 * bigbud asks for file access, for the AI and for "Search this computer" alike, so the probe
 * opens every folder search later reads at that level. macOS then shows each privacy prompt
 * (Desktop, Documents, Downloads, iCloud Drive, File Provider storage) now, not mid-search.
 *
 * The folder lists come from `@bigbud/shared/search/osIndexScopeFolders`, the definition the
 * agent's search scopes are pinned to. Missing folders are ignored and a declined prompt only
 * lands the folder in `denied`; the probe itself never fails.
 */
import * as nodePath from "node:path";

import { isOsIndexExcludedPath } from "@bigbud/shared/search/osIndexExclusions";
import {
  OS_INDEX_COMMON_FOLDERS,
  OS_INDEX_MACOS_CLOUD_FOLDERS,
  OS_INDEX_MACOS_NOISE_FOLDER,
} from "@bigbud/shared/search/osIndexScopeFolders";

export interface FileAccessProbeEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
}

export interface FileAccessProbeResult {
  readonly success: boolean;
  readonly granted: string[];
  readonly denied: string[];
}

export interface FileAccessProbeOptions {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  /** Lists a folder; reading the listing is what makes macOS ask. Symlinks are not followed. */
  readonly readFolder: (folder: string) => Promise<ReadonlyArray<FileAccessProbeEntry>>;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Opens the folders "Search this computer" and the AI may read at `level`, one at a time. */
export async function probeFileAccess(
  level: unknown,
  options: FileAccessProbeOptions,
): Promise<FileAccessProbeResult> {
  const { home, platform, readFolder } = options;
  const path = platform === "win32" ? nodePath.win32 : nodePath.posix;
  const granted: string[] = [];
  const denied: string[] = [];
  const opened = new Set<string>();

  // Sequential on purpose: macOS shows one prompt at a time.
  const open = async (folder: string): Promise<ReadonlyArray<FileAccessProbeEntry>> => {
    if (opened.has(folder) || isOsIndexExcludedPath(folder, home)) return [];
    opened.add(folder);
    try {
      const entries = await readFolder(folder);
      granted.push(folder);
      return entries;
    } catch (error) {
      if (!isMissing(error)) denied.push(folder);
      return [];
    }
  };
  const subfolders = (folder: string, entries: ReadonlyArray<FileAccessProbeEntry>) =>
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(folder, entry.name));
  const commonFolders = OS_INDEX_COMMON_FOLDERS.map((folder) => path.join(home, folder));

  if (level === "common-folders") {
    for (const folder of commonFolders) await open(folder);
  } else if (level === "unrestricted") {
    const isMac = platform === "darwin";
    await open(path.parse(home).root);
    if (isMac) await open("/Users");
    // Search scopes every visible home folder except the macOS noise folder (`~/Library`).
    const noiseFolder = OS_INDEX_MACOS_NOISE_FOLDER.toLowerCase();
    const homeFolders = subfolders(home, await open(home)).filter(
      (folder) => !isMac || path.basename(folder).toLowerCase() !== noiseFolder,
    );
    for (const folder of [...commonFolders, ...homeFolders]) await open(folder);
    if (isMac) {
      // iCloud Drive and each File Provider (Dropbox, Google Drive, ...) has its own prompt.
      for (const cloud of OS_INDEX_MACOS_CLOUD_FOLDERS) {
        const cloudFolder = path.join(home, cloud);
        for (const provider of subfolders(cloudFolder, await open(cloudFolder))) {
          await open(provider);
        }
      }
    }
  }

  return { success: granted.length > 0, granted, denied };
}
