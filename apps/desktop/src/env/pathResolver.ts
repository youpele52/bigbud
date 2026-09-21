import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { app, nativeImage } from "electron";
import { BIGBUD_LINUX_EXECUTABLE_NAME } from "@bigbud/shared/platform";

import {
  resolvePackagedBackendLauncherPlan,
  resolvePackagedOpencodeBinaryPlan,
  resolvePackagedWorkspaceAgentPlan,
  resolvePackagedDesktopSupervisorPlan,
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

export function resolveBackendLauncherPath(): string {
  if (!app.isPackaged) {
    return process.execPath;
  }

  const plan = resolvePackagedBackendLauncherPlan(
    process.platform,
    process.execPath,
    process.env.APPDIR,
    BIGBUD_LINUX_EXECUTABLE_NAME,
  );

  if (plan.source === "appDirExecutable" && FS.existsSync(plan.launcherPath)) {
    return plan.launcherPath;
  }

  return process.execPath;
}

export function resolveBackendNodeExecutable(backendLauncherPath: string): string {
  if (process.platform !== "darwin") return backendLauncherPath;
  const executableName = Path.basename(backendLauncherPath);
  const contentsDir = Path.resolve(Path.dirname(backendLauncherPath), "..");
  const helperPath = Path.join(
    contentsDir,
    "Frameworks",
    `${executableName} Helper.app`,
    "Contents",
    "MacOS",
    `${executableName} Helper`,
  );
  return FS.existsSync(helperPath) ? helperPath : backendLauncherPath;
}

export function resolvePackagedOpencodeBinaryDir(): string | null {
  if (!app.isPackaged) return null;

  const plan = resolvePackagedOpencodeBinaryPlan(process.platform, process.resourcesPath);
  return FS.existsSync(plan.binaryPath) ? plan.binDir : null;
}

export function resolvePackagedWorkspaceAgentBinary(): string | null {
  if (!app.isPackaged) return null;

  const plan = resolvePackagedWorkspaceAgentPlan(process.platform, process.resourcesPath);
  return FS.existsSync(plan.binaryPath) ? plan.binaryPath : null;
}

export function resolvePackagedDesktopSupervisorBinary(): string | null {
  if (!app.isPackaged) return null;

  const plan = resolvePackagedDesktopSupervisorPlan(process.platform, process.resourcesPath);
  return FS.existsSync(plan.binaryPath) ? plan.binaryPath : null;
}

export function resolvePackagedBundledSkillsDir(): string | null {
  if (!app.isPackaged) return null;

  const skillsDir = Path.join(process.resourcesPath, "server/bundled-skills");
  return FS.existsSync(skillsDir) ? skillsDir : null;
}

export function resolvePackagedBundledAgentsDir(): string | null {
  if (!app.isPackaged) return null;

  const agentsDir = Path.join(process.resourcesPath, "server/bundled-agents");
  return FS.existsSync(agentsDir) ? agentsDir : null;
}

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
