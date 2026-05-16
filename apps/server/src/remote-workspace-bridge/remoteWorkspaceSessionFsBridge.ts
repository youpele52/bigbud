import fs from "node:fs/promises";
import path from "node:path";
import posixPath from "node:path/posix";

import type { SessionFsConfig, SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";

import { runToolCommand, resolveToolTransportTarget } from "../tool-transport/toolTransport.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceBridge } from "./remoteWorkspaceBridge.ts";

export const REMOTE_WORKSPACE_SESSION_STATE_PATH = ".bigbud/session-state";
const DEFAULT_REMOTE_TIMEOUT_MS = 30_000;

export interface RemoteWorkspaceSessionFsBridge {
  readonly cwd: string;
  readonly destination: string;
  readonly initialCwd: string;
  readonly sessionFsConfig: SessionFsConfig;
  createSessionFsHandler(): SessionFsProvider;
  cleanup(): Promise<void>;
}

function createErrnoError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

interface ResolvedSessionFsPath {
  readonly kind: "session-state" | "workspace";
  readonly path: string;
}

function isSessionStatePath(pathname: string): boolean {
  return (
    pathname === REMOTE_WORKSPACE_SESSION_STATE_PATH ||
    pathname.startsWith(`${REMOTE_WORKSPACE_SESSION_STATE_PATH}/`)
  );
}

export function resolveSessionFsPath(inputPath: string, initialCwd: string): ResolvedSessionFsPath {
  const normalizedPath = posixPath.normalize(inputPath);
  if (isSessionStatePath(normalizedPath)) {
    return { kind: "session-state", path: normalizedPath };
  }

  return {
    kind: "workspace",
    path: posixPath.isAbsolute(normalizedPath)
      ? normalizedPath
      : posixPath.resolve(initialCwd, normalizedPath),
  };
}

function resolveSessionStateFsPath(pathname: string, stateRoot: string): string {
  const relativePath =
    pathname === REMOTE_WORKSPACE_SESSION_STATE_PATH
      ? "."
      : pathname.slice(REMOTE_WORKSPACE_SESSION_STATE_PATH.length + 1);
  const resolved = path.resolve(stateRoot, relativePath);
  const normalizedRoot = path.resolve(stateRoot);
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw createErrnoError("EPERM", `Path escapes session state root: ${pathname}`);
  }
  return resolved;
}

function toIsoTimestamp(input: string): string {
  const epochSeconds = Number(input);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) {
    return new Date(0).toISOString();
  }
  return new Date(epochSeconds * 1_000).toISOString();
}

function normalizeBirthtime(birthtime: string, mtime: string): string {
  const epochSeconds = Number(birthtime);
  return Number.isFinite(epochSeconds) && epochSeconds >= 0 ? toIsoTimestamp(birthtime) : mtime;
}

function toSessionFsFileInfo(stats: Awaited<ReturnType<typeof fs.stat>>): SessionFsFileInfo {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    size: Number(stats.size),
    mtime: stats.mtime.toISOString(),
    birthtime: stats.birthtime.toISOString(),
  };
}

export async function createRemoteWorkspaceSessionFsBridge(
  workspaceTarget: WorkspaceTarget,
  prefix: string,
  readmeLines: ReadonlyArray<string>,
): Promise<RemoteWorkspaceSessionFsBridge> {
  const bridge = await createRemoteWorkspaceBridge({
    workspaceTarget,
    prefix,
    readmeLines,
  });
  const stateRoot = path.join(bridge.bridgeDir, "session-state");
  await fs.mkdir(stateRoot, { recursive: true });
  const transportTarget = resolveToolTransportTarget(workspaceTarget);
  const initialCwd = workspaceTarget.cwd ?? "/";

  const runRemoteShell = (
    script: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly stdin?: string;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
    },
  ) =>
    runToolCommand({
      target: transportTarget,
      command: "sh",
      args: ["-lc", script, "bigbud-session-fs", ...args],
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      timeoutMs: options?.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
    });

  const existsRemotePath = async (pathname: string): Promise<boolean> => {
    const result = await runRemoteShell('test -e "$1"', [pathname], {
      allowNonZeroExit: true,
    });
    return result.code === 0;
  };

  const createRemoteHandler = (): SessionFsProvider => {
    const readRemoteFile = async (pathname: string): Promise<string> => {
      const result = await runRemoteShell(
        [
          "set -eu",
          "target=$1",
          'if [ ! -f "$target" ]; then printf "Not a file: %s\\n" "$target" >&2; exit 1; fi',
          'if [ ! -r "$target" ]; then printf "Cannot read file: %s\\n" "$target" >&2; exit 1; fi',
          'cat -- "$target"',
        ].join("\n"),
        [pathname],
      );
      return result.stdout;
    };

    return {
      async readFile(inputPath: string): Promise<string> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          return fs.readFile(resolveSessionStateFsPath(resolvedPath.path, stateRoot), "utf8");
        }
        if (!(await existsRemotePath(resolvedPath.path))) {
          throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
        }
        return readRemoteFile(resolvedPath.path);
      },
      async writeFile(inputPath: string, content: string): Promise<void> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          const filePath = resolveSessionStateFsPath(resolvedPath.path, stateRoot);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf8");
          return;
        }
        await runRemoteShell(
          ["set -eu", "target=$1", 'mkdir -p -- "$(dirname -- "$target")"', 'cat > "$target"'].join(
            "\n",
          ),
          [resolvedPath.path],
          { stdin: content },
        );
      },
      async appendFile(inputPath: string, content: string): Promise<void> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          const filePath = resolveSessionStateFsPath(resolvedPath.path, stateRoot);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.appendFile(filePath, content, "utf8");
          return;
        }
        await runRemoteShell(
          [
            "set -eu",
            "target=$1",
            'mkdir -p -- "$(dirname -- "$target")"',
            'cat >> "$target"',
          ].join("\n"),
          [resolvedPath.path],
          { stdin: content },
        );
      },
      async exists(inputPath: string): Promise<boolean> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          return fs
            .access(resolveSessionStateFsPath(resolvedPath.path, stateRoot))
            .then(() => true)
            .catch(() => false);
        }
        return existsRemotePath(resolvedPath.path);
      },
      async stat(inputPath: string): Promise<SessionFsFileInfo> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          return toSessionFsFileInfo(
            await fs.stat(resolveSessionStateFsPath(resolvedPath.path, stateRoot)),
          );
        }
        if (!(await existsRemotePath(resolvedPath.path))) {
          throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
        }
        const result = await runRemoteShell(
          [
            "set -eu",
            "target=$1",
            'kind="file"',
            'if [ -d "$target" ]; then kind="directory"; fi',
            'size=$(stat -c %s -- "$target")',
            'mtime=$(stat -c %Y -- "$target")',
            'birthtime=$(stat -c %W -- "$target" 2>/dev/null || printf -- "-1")',
            'printf "%s\\t%s\\t%s\\t%s\\n" "$kind" "$size" "$mtime" "$birthtime"',
          ].join("\n"),
          [resolvedPath.path],
        );
        const [kind = "file", size = "0", mtime = "0", birthtime = "-1"] = result.stdout
          .trim()
          .split("\t");
        const mtimeIso = toIsoTimestamp(mtime);
        return {
          isFile: kind !== "directory",
          isDirectory: kind === "directory",
          size: Number(size) || 0,
          mtime: mtimeIso,
          birthtime: normalizeBirthtime(birthtime, mtimeIso),
        };
      },
      async mkdir(inputPath: string, recursive: boolean, mode?: number): Promise<void> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          await fs.mkdir(resolveSessionStateFsPath(resolvedPath.path, stateRoot), {
            recursive,
            ...(mode !== undefined ? { mode } : {}),
          });
          return;
        }
        await runRemoteShell(
          ["set -eu", "target=$1", recursive ? 'mkdir -p -- "$target"' : 'mkdir -- "$target"'].join(
            "\n",
          ),
          [resolvedPath.path],
        );
      },
      async readdir(inputPath: string): Promise<string[]> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          return fs.readdir(resolveSessionStateFsPath(resolvedPath.path, stateRoot));
        }
        if (!(await existsRemotePath(resolvedPath.path))) {
          throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
        }
        const result = await runRemoteShell(
          [
            "set -eu",
            "target=$1",
            'if [ ! -d "$target" ]; then printf "Not a directory: %s\\n" "$target" >&2; exit 1; fi',
            'find "$target" -mindepth 1 -maxdepth 1 -printf "%f\\n" | LC_ALL=C sort',
          ].join("\n"),
          [resolvedPath.path],
        );
        return result.stdout
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
      },
      async readdirWithTypes(inputPath: string) {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          const entries = await fs.readdir(
            resolveSessionStateFsPath(resolvedPath.path, stateRoot),
            {
              withFileTypes: true,
            },
          );
          return entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
          }));
        }
        if (!(await existsRemotePath(resolvedPath.path))) {
          throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
        }
        const result = await runRemoteShell(
          [
            "set -eu",
            "target=$1",
            'if [ ! -d "$target" ]; then printf "Not a directory: %s\\n" "$target" >&2; exit 1; fi',
            'find "$target" -mindepth 1 -maxdepth 1 -printf "%f\\t%y\\n" | LC_ALL=C sort',
          ].join("\n"),
          [resolvedPath.path],
        );
        return result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const [name = "", type = "f"] = line.split("\t");
            return {
              name,
              type: type === "d" ? ("directory" as const) : ("file" as const),
            };
          });
      },
      async rm(inputPath: string, recursive: boolean, force: boolean): Promise<void> {
        const resolvedPath = resolveSessionFsPath(inputPath, initialCwd);
        if (resolvedPath.kind === "session-state") {
          await fs.rm(resolveSessionStateFsPath(resolvedPath.path, stateRoot), {
            recursive,
            force,
          });
          return;
        }
        await runRemoteShell(
          [
            "set -eu",
            "target=$1",
            `rm ${recursive ? "-r" : ""}${force ? " -f" : ""} -- "$target"`,
          ].join("\n"),
          [resolvedPath.path],
          { allowNonZeroExit: force },
        ).then((result) => {
          if (!force && result.code !== 0) {
            throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
          }
        });
      },
      async rename(sourcePath: string, destinationPath: string): Promise<void> {
        const source = resolveSessionFsPath(sourcePath, initialCwd);
        const destination = resolveSessionFsPath(destinationPath, initialCwd);
        if (source.kind === "session-state" || destination.kind === "session-state") {
          if (source.kind !== "session-state" || destination.kind !== "session-state") {
            throw createErrnoError(
              "EXDEV",
              "Cross-root renames between session state and remote workspace are not supported.",
            );
          }
          const sourceFile = resolveSessionStateFsPath(source.path, stateRoot);
          const destinationFile = resolveSessionStateFsPath(destination.path, stateRoot);
          await fs.mkdir(path.dirname(destinationFile), { recursive: true });
          await fs.rename(sourceFile, destinationFile);
          return;
        }
        await runRemoteShell(
          [
            "set -eu",
            "source=$1",
            "destination=$2",
            'mkdir -p -- "$(dirname -- "$destination")"',
            'mv -- "$source" "$destination"',
          ].join("\n"),
          [source.path, destination.path],
        );
      },
    };
  };

  return {
    cwd: bridge.cwd,
    destination: bridge.config.destination,
    initialCwd,
    sessionFsConfig: {
      initialCwd,
      sessionStatePath: REMOTE_WORKSPACE_SESSION_STATE_PATH,
      conventions: "posix",
    },
    createSessionFsHandler: createRemoteHandler,
    cleanup: bridge.cleanup,
  };
}
