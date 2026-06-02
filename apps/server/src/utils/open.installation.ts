import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { EDITORS } from "@bigbud/contracts";

type EditorDefinition = (typeof EDITORS)[number];
type EditorInstallationEvidence = {
  readonly darwinAppNames?: readonly string[];
  readonly linuxDesktopIds?: readonly string[];
  readonly win32AppPaths?: readonly string[];
};

const DEFAULT_DARWIN_APPLICATION_DIRS = ["/Applications", "/System/Applications", "~/Applications"];
const DEFAULT_LINUX_APPLICATION_DIRS = [
  "/usr/share/applications",
  "/usr/local/share/applications",
  "/var/lib/flatpak/exports/share/applications",
  "/var/lib/snapd/desktop/applications",
  "~/.local/share/applications",
];
const DEFAULT_WIN32_APPLICATION_ROOTS = ["%LOCALAPPDATA%", "%APPDATA%", "%ProgramFiles%"];

function fileExists(pathValue: string): boolean {
  try {
    accessSync(pathValue, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveInstallationEvidence(
  editor: EditorDefinition,
): EditorInstallationEvidence | undefined {
  return "installationEvidence" in editor ? editor.installationEvidence : undefined;
}

function resolveHomeDirectory(env: NodeJS.ProcessEnv): string | null {
  return env.HOME ?? env.USERPROFILE ?? null;
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function expandHomePath(pathValue: string, env: NodeJS.ProcessEnv): string {
  if (!pathValue.startsWith("~/")) {
    return pathValue;
  }
  const homeDirectory = resolveHomeDirectory(env);
  return homeDirectory ? join(homeDirectory, pathValue.slice(2)) : pathValue;
}

function splitConfiguredDirectories(
  rawValue: string | undefined,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(resolvePathDelimiter(platform))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveDarwinApplicationDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = splitConfiguredDirectories(env.BIGBUD_EDITOR_APP_DIRS_DARWIN, "darwin");
  const candidates = configured.length > 0 ? configured : DEFAULT_DARWIN_APPLICATION_DIRS;
  return candidates.map((candidate) => expandHomePath(candidate, env));
}

function resolveLinuxDesktopDirectories(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = splitConfiguredDirectories(env.BIGBUD_EDITOR_APP_DIRS_LINUX, "linux");
  const candidates = configured.length > 0 ? configured : DEFAULT_LINUX_APPLICATION_DIRS;
  return candidates.map((candidate) => expandHomePath(candidate, env));
}

function resolveWin32ApplicationRoots(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = splitConfiguredDirectories(env.BIGBUD_EDITOR_APP_DIRS_WIN32, "win32");
  if (configured.length > 0) {
    return configured;
  }
  return DEFAULT_WIN32_APPLICATION_ROOTS.flatMap((token) => {
    switch (token) {
      case "%LOCALAPPDATA%":
        return env.LOCALAPPDATA ? [env.LOCALAPPDATA] : [];
      case "%APPDATA%":
        return env.APPDATA ? [env.APPDATA] : [];
      case "%ProgramFiles%":
        return [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
      default:
        return [];
    }
  });
}

export function resolveDarwinEditorApp(
  editor: EditorDefinition,
  env: NodeJS.ProcessEnv,
): string | null {
  const appNames = resolveInstallationEvidence(editor)?.darwinAppNames;
  if (!appNames) {
    return null;
  }
  for (const directory of resolveDarwinApplicationDirectories(env)) {
    for (const appName of appNames) {
      const appPath = join(directory, appName);
      if (fileExists(appPath)) {
        return appPath;
      }
    }
  }
  return null;
}

export function resolveLinuxEditorDesktopEntry(
  editor: EditorDefinition,
  env: NodeJS.ProcessEnv,
): string | null {
  const desktopIds = resolveInstallationEvidence(editor)?.linuxDesktopIds;
  if (!desktopIds) {
    return null;
  }
  for (const directory of resolveLinuxDesktopDirectories(env)) {
    for (const desktopId of desktopIds) {
      const desktopFilePath = join(directory, desktopId);
      if (fileExists(desktopFilePath)) {
        return desktopFilePath;
      }
    }
  }
  return null;
}

export function resolveWin32EditorExecutable(
  editor: EditorDefinition,
  env: NodeJS.ProcessEnv,
): string | null {
  const appPaths = resolveInstallationEvidence(editor)?.win32AppPaths;
  if (!appPaths) {
    return null;
  }
  for (const root of resolveWin32ApplicationRoots(env)) {
    for (const relativePath of appPaths) {
      const executablePath = join(root, ...relativePath.split("/"));
      if (fileExists(executablePath)) {
        return executablePath;
      }
    }
  }
  return null;
}

export function hasPlatformInstallationEvidence(
  editor: EditorDefinition,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): boolean {
  switch (platform) {
    case "darwin":
      return resolveDarwinEditorApp(editor, env) !== null;
    case "linux":
      return resolveLinuxEditorDesktopEntry(editor, env) !== null;
    case "win32":
      return resolveWin32EditorExecutable(editor, env) !== null;
    default:
      return false;
  }
}

export function hasDarwinInstallationEvidence(editor: EditorDefinition): boolean {
  return (resolveInstallationEvidence(editor)?.darwinAppNames?.length ?? 0) > 0;
}
