import fs from "node:fs/promises";
import path from "node:path";

import type { SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";

import type { ProcessRunResult } from "../utils/processRunner.ts";
import {
  createErrnoError,
  resolveSessionFsPath,
  resolveSessionStateFsPath,
  remoteWorkspaceSessionFsInvocationId,
  type ResolvedSessionFsPath,
} from "./remoteWorkspaceSessionFsBridge.paths.ts";
import { createRemoteSessionFsSequence } from "./remoteWorkspaceSessionFsBridge.sequence.ts";

export interface RemoteSessionFsShellOptions {
  readonly invocationId?: string;
  readonly stdin?: string;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
}

interface RemoteSessionFsHandlerInput {
  readonly sessionId: string;
  readonly initialCwd: string;
  readonly bridgeCwd: string;
  readonly stateRoot: string;
  readonly readiness: { readonly os: "linux" | "darwin" };
  readonly runRemoteShell: (
    script: string,
    args: ReadonlyArray<string>,
    options?: RemoteSessionFsShellOptions,
  ) => Promise<ProcessRunResult>;
}

function toIsoTimestamp(input: string): string {
  const epochSeconds = Number(input);
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) return new Date(0).toISOString();
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

export function createRemoteSessionFsProvider(
  input: RemoteSessionFsHandlerInput,
): SessionFsProvider {
  const resolve = (pathname: string): ResolvedSessionFsPath =>
    resolveSessionFsPath(pathname, input.initialCwd, input.bridgeCwd);
  const statePath = (pathname: string) => resolveSessionStateFsPath(pathname, input.stateRoot);
  const operationSequence = createRemoteSessionFsSequence(input.stateRoot, input.sessionId);
  const invocation = async (operation: string, paths: ReadonlyArray<string>, mutation = false) => {
    const sequence = await operationSequence.allocate(operation, mutation);
    return {
      id: remoteWorkspaceSessionFsInvocationId(input.sessionId, operation, paths, sequence),
      sequence,
    };
  };
  const runRemoteMutation = async <T>(
    operation: string,
    paths: ReadonlyArray<string>,
    run: (invocationId: string) => Promise<T>,
  ): Promise<T> => {
    const allocated = await invocation(operation, paths, true);
    try {
      const result = await run(allocated.id);
      await operationSequence.complete(allocated.sequence);
      return result;
    } catch (cause) {
      await operationSequence.markAmbiguous(allocated.sequence).catch(() => undefined);
      throw cause;
    }
  };

  const existsRemotePath = async (pathname: string): Promise<boolean> => {
    const result = await input.runRemoteShell('test -e "$1"', [pathname], {
      invocationId: (await invocation("exists", [pathname])).id,
      allowNonZeroExit: true,
    });
    return result.code === 0;
  };
  const readRemoteFile = async (pathname: string): Promise<string> => {
    const result = await input.runRemoteShell(
      [
        "set -eu",
        "target=$1",
        'if [ ! -f "$target" ]; then printf "Not a file: %s\\n" "$target" >&2; exit 1; fi',
        'if [ ! -r "$target" ]; then printf "Cannot read file: %s\\n" "$target" >&2; exit 1; fi',
        'cat -- "$target"',
      ].join("\n"),
      [pathname],
      { invocationId: (await invocation("read", [pathname])).id },
    );
    return result.stdout;
  };

  return {
    async readFile(inputPath: string): Promise<string> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state")
        return fs.readFile(statePath(resolvedPath.path), "utf8");
      if (!(await existsRemotePath(resolvedPath.path)))
        throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
      return readRemoteFile(resolvedPath.path);
    },
    async writeFile(inputPath: string, content: string): Promise<void> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state") {
        const filePath = statePath(resolvedPath.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
        return;
      }
      await runRemoteMutation("write", [resolvedPath.path], (invocationId) =>
        input.runRemoteShell(
          ["set -eu", "target=$1", 'mkdir -p -- "$(dirname -- "$target")"', 'cat > "$target"'].join(
            "\n",
          ),
          [resolvedPath.path],
          { invocationId, stdin: content },
        ),
      );
    },
    async appendFile(inputPath: string, content: string): Promise<void> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state") {
        const filePath = statePath(resolvedPath.path);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, content, "utf8");
        return;
      }
      await runRemoteMutation("append", [resolvedPath.path], (invocationId) =>
        input.runRemoteShell(
          [
            "set -eu",
            "target=$1",
            'mkdir -p -- "$(dirname -- "$target")"',
            'cat >> "$target"',
          ].join("\n"),
          [resolvedPath.path],
          { invocationId, stdin: content },
        ),
      );
    },
    async exists(inputPath: string): Promise<boolean> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state")
        return fs
          .access(statePath(resolvedPath.path))
          .then(() => true)
          .catch(() => false);
      return existsRemotePath(resolvedPath.path);
    },
    async stat(inputPath: string): Promise<SessionFsFileInfo> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state")
        return toSessionFsFileInfo(await fs.stat(statePath(resolvedPath.path)));
      if (!(await existsRemotePath(resolvedPath.path)))
        throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
      const result = await input.runRemoteShell(
        [
          "set -eu",
          "target=$1",
          'kind="file"',
          'if [ -d "$target" ]; then kind="directory"; fi',
          input.readiness.os === "darwin"
            ? 'size=$(stat -f %z -- "$target"); mtime=$(stat -f %m -- "$target"); birthtime=$(stat -f %B -- "$target" 2>/dev/null || printf -- "-1")'
            : 'size=$(stat -c %s -- "$target"); mtime=$(stat -c %Y -- "$target"); birthtime=$(stat -c %W -- "$target" 2>/dev/null || printf -- "-1")',
          'printf "%s\\t%s\\t%s\\t%s\\n" "$kind" "$size" "$mtime" "$birthtime"',
        ].join("\n"),
        [resolvedPath.path],
        { invocationId: (await invocation("stat", [resolvedPath.path])).id },
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
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state") {
        await fs.mkdir(statePath(resolvedPath.path), {
          recursive,
          ...(mode !== undefined ? { mode } : {}),
        });
        return;
      }
      await runRemoteMutation("mkdir", [resolvedPath.path, String(recursive)], (invocationId) =>
        input.runRemoteShell(
          ["set -eu", "target=$1", recursive ? 'mkdir -p -- "$target"' : 'mkdir -- "$target"'].join(
            "\n",
          ),
          [resolvedPath.path],
          { invocationId },
        ),
      );
    },
    async readdir(inputPath: string): Promise<string[]> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state") return fs.readdir(statePath(resolvedPath.path));
      if (!(await existsRemotePath(resolvedPath.path)))
        throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
      const result = await input.runRemoteShell(
        [
          "set -eu",
          "target=$1",
          'if [ ! -d "$target" ]; then printf "Not a directory: %s\\n" "$target" >&2; exit 1; fi',
          'find "$target" -mindepth 1 -maxdepth 1 -exec basename {} \\; | LC_ALL=C sort',
        ].join("\n"),
        [resolvedPath.path],
        { invocationId: (await invocation("readdir", [resolvedPath.path])).id },
      );
      return result.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    },
    async readdirWithTypes(inputPath: string) {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state") {
        const entries = await fs.readdir(statePath(resolvedPath.path), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
      }
      if (!(await existsRemotePath(resolvedPath.path)))
        throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
      const result = await input.runRemoteShell(
        [
          "set -eu",
          "target=$1",
          'if [ ! -d "$target" ]; then printf "Not a directory: %s\\n" "$target" >&2; exit 1; fi',
          'find "$target" -mindepth 1 -maxdepth 1 -printf "%f\\t%y\\n" | LC_ALL=C sort',
        ].join("\n"),
        [resolvedPath.path],
        { invocationId: (await invocation("readdirWithTypes", [resolvedPath.path])).id },
      );
      return result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const [name = "", type = "f"] = line.split("\t");
          return { name, type: type === "d" ? ("directory" as const) : ("file" as const) };
        });
    },
    async rm(inputPath: string, recursive: boolean, force: boolean): Promise<void> {
      const resolvedPath = resolve(inputPath);
      if (resolvedPath.kind === "session-state") {
        await fs.rm(statePath(resolvedPath.path), { recursive, force });
        return;
      }
      await runRemoteMutation(
        "remove",
        [resolvedPath.path, String(recursive), String(force)],
        async (invocationId) => {
          const result = await input.runRemoteShell(
            [
              "set -eu",
              "target=$1",
              `rm ${recursive ? "-r" : ""}${force ? " -f" : ""} -- "$target"`,
            ].join("\n"),
            [resolvedPath.path],
            { invocationId, allowNonZeroExit: force },
          );
          if (!force && result.code !== 0)
            throw createErrnoError("ENOENT", `Path not found: ${resolvedPath.path}`);
        },
      );
    },
    async rename(sourcePath: string, destinationPath: string): Promise<void> {
      const source = resolve(sourcePath);
      const destination = resolve(destinationPath);
      if (source.kind === "session-state" || destination.kind === "session-state") {
        if (source.kind !== "session-state" || destination.kind !== "session-state")
          throw createErrnoError(
            "EXDEV",
            "Cross-root renames between session state and remote workspace are not supported.",
          );
        const sourceFile = statePath(source.path);
        const destinationFile = statePath(destination.path);
        await fs.mkdir(path.dirname(destinationFile), { recursive: true });
        await fs.rename(sourceFile, destinationFile);
        return;
      }
      await runRemoteMutation("rename", [source.path, destination.path], (invocationId) =>
        input.runRemoteShell(
          [
            "set -eu",
            "source=$1",
            "destination=$2",
            'mkdir -p -- "$(dirname -- "$destination")"',
            'mv -- "$source" "$destination"',
          ].join("\n"),
          [source.path, destination.path],
          { invocationId },
        ),
      );
    },
  };
}
