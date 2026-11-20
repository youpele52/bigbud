/**
 * The folders "Search this computer" scopes to, per File Access level (system-wide search plan
 * §6). `osIndexScopeFolders.json` is the single definition: the Rust agent's `scope.rs` and
 * `scope_layout.rs` constants are pinned to it by a parity test, and TypeScript reads it directly
 * (the desktop File Access probe and the Settings folder list), so the folders macOS asks about
 * when File Access is chosen are the folders search later reads.
 */
import folders from "./osIndexScopeFolders.json" with { type: "json" };

/** Home children searched at the `common-folders` level (and inside `unrestricted`). */
export const OS_INDEX_COMMON_FOLDERS: ReadonlyArray<string> = folders.commonFolders;

/** macOS home child never searched as a whole at `unrestricted` (caches, app state). */
export const OS_INDEX_MACOS_NOISE_FOLDER: string = folders.macos.noiseFolder;

/**
 * Home-relative cloud folders inside the noise folder searched at `unrestricted` on macOS:
 * iCloud Drive and File Provider storage (Dropbox, Google Drive, OneDrive, ...).
 */
export const OS_INDEX_MACOS_CLOUD_FOLDERS: ReadonlyArray<string> = folders.macos.cloudFolders;
