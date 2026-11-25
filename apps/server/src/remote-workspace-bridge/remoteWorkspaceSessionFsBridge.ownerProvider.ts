import fs from "node:fs/promises";
import path from "node:path";

import type { SessionFsFileInfo, SessionFsProvider } from "@github/copilot-sdk";

import { SelectedSshOwnerWorkspaceBridgeError } from "./remoteWorkspaceReadiness.ts";
import {
  REMOTE_WORKSPACE_SESSION_STATE_PATH,
  resolveSessionFsPath,
  resolveSessionStateFsPath,
} from "./remoteWorkspaceSessionFsBridge.paths.ts";

const MAX_FILE_BYTES = 512 * 1024;

export interface SessionFsOwnerMethods {
  probeProofWorkspaceReadiness(input: {
    executionTargetId: string;
    workspaceRoot: string;
  }): Promise<{ os: "darwin" | "linux"; architecture: string }>;
  readProofWorkspaceFile(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
    kind: "range";
    offset: number;
    maxBytes: number;
  }): Promise<{ data: Uint8Array; sizeBytes: number; truncated: boolean }>;
  writeProofWorkspaceFile(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
    contents: Uint8Array;
  }): Promise<void>;
  createProofWorkspaceDirectory(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
  }): Promise<"created" | "alreadyExists">;
  deleteProofWorkspaceEntry(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
    expectedDirectory: boolean;
  }): Promise<"deleted" | "notFound">;
}

export interface SessionFsOwnerCapability {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: SessionFsOwnerMethods) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

interface SelectedProviderInput {
  readonly capability: SessionFsOwnerCapability;
  readonly initialCwd: string;
  readonly bridgeCwd: string;
  readonly stateRoot: string;
}

const unsupported = (operation: string) =>
  new SelectedSshOwnerWorkspaceBridgeError("session-filesystem", operation);

function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw unsupported("read");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/**
 * Typed selected-owner session filesystem. Only operations with an explicit
 * owner verb are available; every other remote operation refuses instead of
 * dispatching a shell. Session-state files stay local to the bridge.
 */
export function createSelectedSessionFsProvider(input: SelectedProviderInput): SessionFsProvider {
  const { capability } = input;
  const resolve = (pathname: string) =>
    resolveSessionFsPath(pathname, input.initialCwd, input.bridgeCwd);
  const statePath = (pathname: string) => resolveSessionStateFsPath(pathname, input.stateRoot);
  const relative = (pathname: string): string | undefined => {
    const resolved = resolve(pathname);
    if (resolved.kind !== "workspace") return undefined;
    if (!resolved.path.startsWith(`${capability.workspaceRoot}/`)) throw unsupported("path");
    const value = resolved.path.slice(capability.workspaceRoot.length + 1);
    if (
      !value ||
      value === REMOTE_WORKSPACE_SESSION_STATE_PATH ||
      value.startsWith(`${REMOTE_WORKSPACE_SESSION_STATE_PATH}/`)
    )
      throw unsupported("path");
    return value;
  };

  return {
    async readFile(pathname: string): Promise<string> {
      if (resolve(pathname).kind === "session-state")
        return fs.readFile(statePath(pathname), "utf8");
      const relativePath = relative(pathname);
      if (!relativePath) throw unsupported("read");
      const file = await capability.withOwner(capability.targetId, (owner) =>
        owner.readProofWorkspaceFile({
          executionTargetId: capability.targetId,
          workspaceRoot: capability.workspaceRoot,
          relativePath,
          kind: "range",
          offset: 0,
          maxBytes: MAX_FILE_BYTES,
        }),
      );
      if (
        file.truncated ||
        file.sizeBytes !== file.data.length ||
        file.data.length > MAX_FILE_BYTES
      )
        throw unsupported("read");
      return decodeText(file.data);
    },
    async writeFile(pathname: string, content: string): Promise<void> {
      if (resolve(pathname).kind === "session-state") {
        const filePath = statePath(pathname);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
        return;
      }
      const relativePath = relative(pathname);
      if (!relativePath) throw unsupported("write");
      const contents = new TextEncoder().encode(content);
      if (contents.byteLength > MAX_FILE_BYTES) throw unsupported("write");
      await capability.withOwner(capability.targetId, (owner) =>
        owner.writeProofWorkspaceFile({
          executionTargetId: capability.targetId,
          workspaceRoot: capability.workspaceRoot,
          relativePath,
          contents,
        }),
      );
    },
    async appendFile(pathname: string, content: string): Promise<void> {
      if (resolve(pathname).kind === "session-state") {
        const filePath = statePath(pathname);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, content, "utf8");
        return;
      }
      throw unsupported("append");
    },
    async exists(pathname: string): Promise<boolean> {
      if (resolve(pathname).kind === "session-state")
        return fs
          .access(statePath(pathname))
          .then(() => true)
          .catch(() => false);
      throw unsupported("exists");
    },
    async stat(pathname: string): Promise<SessionFsFileInfo> {
      if (resolve(pathname).kind === "session-state") {
        const stats = await fs.stat(statePath(pathname));
        return {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: Number(stats.size),
          mtime: stats.mtime.toISOString(),
          birthtime: stats.birthtime.toISOString(),
        };
      }
      throw unsupported("stat");
    },
    async mkdir(pathname: string, recursive: boolean): Promise<void> {
      if (resolve(pathname).kind === "session-state") {
        await fs.mkdir(statePath(pathname), { recursive });
        return;
      }
      if (recursive) throw unsupported("mkdir");
      const relativePath = relative(pathname);
      if (!relativePath) throw unsupported("mkdir");
      await capability.withOwner(capability.targetId, (owner) =>
        owner.createProofWorkspaceDirectory({
          executionTargetId: capability.targetId,
          workspaceRoot: capability.workspaceRoot,
          relativePath,
        }),
      );
    },
    async readdir(pathname: string): Promise<string[]> {
      if (resolve(pathname).kind === "session-state") return fs.readdir(statePath(pathname));
      throw unsupported("readdir");
    },
    async readdirWithTypes(pathname: string) {
      if (resolve(pathname).kind === "session-state") {
        const entries = await fs.readdir(statePath(pathname), { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
      }
      throw unsupported("readdir");
    },
    async rm(pathname: string, recursive: boolean): Promise<void> {
      if (resolve(pathname).kind === "session-state") {
        await fs.rm(statePath(pathname), { recursive, force: false });
        return;
      }
      // An rm request does not carry the confirmed kind. Refuse rather than guess.
      throw unsupported("rm");
    },
    async rename(sourcePath: string, destinationPath: string): Promise<void> {
      if (
        resolve(sourcePath).kind === "session-state" &&
        resolve(destinationPath).kind === "session-state"
      ) {
        const source = statePath(sourcePath);
        const destination = statePath(destinationPath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(source, destination);
        return;
      }
      throw unsupported("rename");
    },
  };
}
