import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { app, nativeImage } from "electron";

import {
  resolveBackendModulesLinkPlan,
  resolvePackagedOpencodeBinaryPlan,
} from "./pathResolver.platform";

// ---------------------------------------------------------------------------
// Constants passed in from main.ts
// ---------------------------------------------------------------------------

const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;

// ---------------------------------------------------------------------------
// Destructive menu icon (cached via closure)
// ---------------------------------------------------------------------------

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;

/**
 * Returns a small trash icon suitable for destructive menu items on macOS.
 * Result is cached after the first successful load.
 */
export function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("trash").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

/**
 * Returns the root directory of the application.
 * In dev this is the monorepo root; in packaged builds it's the asar root.
 */
export function resolveAppRoot(rootDir: string): string {
  if (!app.isPackaged) {
    return rootDir;
  }
  return app.getAppPath();
}

// ---------------------------------------------------------------------------
// app-update.yml
// ---------------------------------------------------------------------------

/** Read the baked-in app-update.yml config (if applicable). */
export function readAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Commit hash helpers
// ---------------------------------------------------------------------------

export function normalizeCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.slice(0, COMMIT_HASH_DISPLAY_LENGTH).toLowerCase();
}

export function resolveEmbeddedCommitHash(rootDir: string): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(rootDir), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      bigcodeCommitHash?: unknown;
      t3codeCommitHash?: unknown;
    };
    return normalizeCommitHash(parsed.bigcodeCommitHash ?? parsed.t3codeCommitHash);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// About commit hash (cached via closure)
// ---------------------------------------------------------------------------

let aboutCommitHashCache: string | null | undefined;

export function resolveAboutCommitHash(rootDir: string): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(
    process.env.BIGBUD_COMMIT_HASH ?? process.env.T3CODE_COMMIT_HASH,
  );
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash(rootDir);

  return aboutCommitHashCache;
}

// ---------------------------------------------------------------------------
// Backend entry / cwd
// ---------------------------------------------------------------------------

export function resolveBackendEntry(rootDir: string): string {
  if (app.isPackaged) {
    // child_process.spawn cannot execute scripts from inside an asar archive.
    // In packaged builds the server dist is placed outside via extraResources.
    return Path.join(process.resourcesPath, "server/dist/bin.mjs");
  }
  return Path.join(resolveAppRoot(rootDir), "apps/server/dist/bin.mjs");
}

export function resolveBackendCwd(rootDir: string): string {
  if (!app.isPackaged) {
    return resolveAppRoot(rootDir);
  }
  return OS.homedir();
}

export function resolvePackagedOpencodeBinaryDir(): string | null {
  if (!app.isPackaged) return null;

  const plan = resolvePackagedOpencodeBinaryPlan(process.platform, process.resourcesPath);
  return FS.existsSync(plan.binaryPath) ? plan.binDir : null;
}

/**
 * Ensures native/external modules are resolvable in packaged builds.
 *
 * electron-builder silently strips directories named `node_modules` from
 * extraResources copies.  The build script works around this by renaming the
 * server's `node_modules` to `_modules`.  At runtime we recreate a
 * resolvable `node_modules` path so that Node.js ESM resolution (which walks
 * up the directory tree looking for `node_modules/`) can find the external
 * packages normally.
 *
 * `NODE_PATH` is intentionally NOT used because Node.js ESM resolution ignores
 * it — only CJS honours `NODE_PATH`.
 *
 * ## Strategy by platform
 *
 * - **macOS / Linux**: relative directory symlink (`_modules` → `node_modules`).
 *   Keeps the .app bundle relocatable.
 * - **Windows**: NTFS junction pointing at the absolute `_modules` path.
 *   Directory symlinks on Windows require Developer Mode or admin privileges;
 *   junctions work without either.  If junction creation also fails (e.g.
 *   cross-volume scenario), falls back to copying `_modules` to `node_modules`
 *   so the packaged backend can always start.
 *
 * No-ops in dev (modules resolve normally from the monorepo).
 */
export function ensureBackendModulesPath(): void {
  if (!app.isPackaged) return;

  const plan = resolveBackendModulesLinkPlan(process.platform, process.resourcesPath);

  if (!FS.existsSync(plan.modulesDir)) return;

  // If node_modules already exists and is the right kind of link, we are done.
  try {
    const stat = FS.lstatSync(plan.nodeModulesPath);
    // Accept either a symlink or a junction — both are reported as symlinks by
    // Node.js lstat on Windows.
    if (stat.isSymbolicLink()) return;
    // Unexpected plain directory or file: remove it and recreate below.
    FS.rmSync(plan.nodeModulesPath, { recursive: true, force: true });
  } catch {
    // Does not exist yet — proceed to creation.
  }

  if (process.platform === "win32") {
    _ensureBackendModulesPathWindows(plan.modulesDir, plan.nodeModulesPath);
  } else {
    _ensureBackendModulesPathPosix(plan.linkTarget, plan.nodeModulesPath);
  }
}

function _ensureBackendModulesPathWindows(
  absoluteModulesDir: string,
  nodeModulesPath: string,
): void {
  // First attempt: NTFS junction (no privilege required).
  try {
    FS.symlinkSync(absoluteModulesDir, nodeModulesPath, "junction");
    console.log("[desktop] created node_modules junction (Windows)");
    return;
  } catch (junctionErr) {
    console.warn("[desktop] junction creation failed, falling back to copy:", junctionErr);
  }

  // Fallback: copy _modules to node_modules.  Heavier but always works.
  try {
    FS.cpSync(absoluteModulesDir, nodeModulesPath, { recursive: true });
    console.log("[desktop] copied _modules → node_modules (Windows fallback)");
  } catch (copyErr) {
    console.error("[desktop] failed to create node_modules (Windows):", copyErr);
  }
}

function _ensureBackendModulesPathPosix(relativeTarget: string, nodeModulesPath: string): void {
  try {
    // Relative symlink keeps the .app bundle relocatable on macOS/Linux.
    FS.symlinkSync(relativeTarget, nodeModulesPath, "dir");
    console.log("[desktop] created node_modules symlink (POSIX)");
  } catch (err) {
    console.error("[desktop] failed to create node_modules symlink:", err);
  }
}

/**
 * @deprecated Use `ensureBackendModulesPath()` instead.
 * Retained as a thin alias so any external callsite keeps compiling while
 * being updated.
 */
export const ensureBackendModulesSymlink = ensureBackendModulesPath;

// ---------------------------------------------------------------------------
// Desktop static asset resolution
// ---------------------------------------------------------------------------

export function resolveDesktopStaticDir(rootDir: string): string | null {
  const candidates = app.isPackaged
    ? [
        Path.join(process.resourcesPath, "server/dist/client"),
        Path.join(resolveAppRoot(rootDir), "apps/server/dist/client"),
      ]
    : [
        Path.join(resolveAppRoot(rootDir), "apps/server/dist/client"),
        Path.join(resolveAppRoot(rootDir), "apps/web/dist"),
      ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

export function resolveDesktopStaticPath(staticRoot: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  const rawPath = decodeURIComponent(url.pathname);
  const normalizedPath = Path.posix.normalize(rawPath).replace(/^\/+/, "");
  if (normalizedPath.includes("..")) {
    return Path.join(staticRoot, "index.html");
  }

  const requestedPath = normalizedPath.length > 0 ? normalizedPath : "index.html";
  const resolvedPath = Path.join(staticRoot, requestedPath);

  if (Path.extname(resolvedPath)) {
    return resolvedPath;
  }

  const nestedIndex = Path.join(resolvedPath, "index.html");
  if (FS.existsSync(nestedIndex)) {
    return nestedIndex;
  }

  return Path.join(staticRoot, "index.html");
}

export function isStaticAssetRequest(requestUrl: string): boolean {
  try {
    const url = new URL(requestUrl);
    return Path.extname(url.pathname).length > 0;
  } catch {
    return false;
  }
}
