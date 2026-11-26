import type { SessionFsFileInfo } from "@github/copilot-sdk";

import type { WorkspaceEntryInfo } from "../ssh/sshOwnerPickerProof.codec.workspaceEntry.ts";
import { SelectedSshOwnerWorkspaceBridgeError } from "./remoteWorkspaceReadiness.ts";
import { createErrnoError } from "./remoteWorkspaceSessionFsBridge.paths.ts";

/**
 * W2 T-files session-FS entry operations over typed owner verbs: directory
 * listing (existing), entry info (122), delete (existing), rename (123) and
 * bounded append (124). Every path is root-relative; nothing runs a shell.
 */
export interface SessionFsEntryOwnerMethods {
  listProofWorkspaceDirectory(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativeDir: string;
  }): Promise<{
    entries: ReadonlyArray<{ readonly name: string; readonly directory: boolean }>;
    truncated: boolean;
  }>;
  workspaceEntryInfo(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
  }): Promise<WorkspaceEntryInfo>;
  deleteProofWorkspaceEntry(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
    expectedDirectory: boolean;
  }): Promise<"deleted" | "notFound">;
  renameWorkspaceEntry(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
    destinationPath: string;
    replace?: boolean;
  }): Promise<"done" | "notFound" | "alreadyExists" | "notAFile">;
  appendWorkspaceFile(input: {
    executionTargetId: string;
    workspaceRoot: string;
    relativePath: string;
    contents: Uint8Array;
  }): Promise<"done" | "notFound" | "alreadyExists" | "notAFile">;
}

interface EntryCapability {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: Partial<SessionFsEntryOwnerMethods>) => Promise<A>,
  ) => Promise<A>;
}

const APPEND_CHUNK = 48 * 1024;
const enoent = (path: string) => createErrnoError("ENOENT", `No such file or directory: ${path}`);
const unsupported = (operation: string) =>
  new SelectedSshOwnerWorkspaceBridgeError("session-filesystem", operation);

export function makeSessionFsOwnerEntries(capability: EntryCapability) {
  const scope = { executionTargetId: capability.targetId, workspaceRoot: capability.workspaceRoot };
  // An owner without the entry verbs (older fixture) keeps the typed refusal.
  const run = <A>(use: (owner: SessionFsEntryOwnerMethods) => Promise<A>) =>
    capability.withOwner(capability.targetId, (owner) => {
      const {
        listProofWorkspaceDirectory,
        workspaceEntryInfo,
        deleteProofWorkspaceEntry,
        renameWorkspaceEntry,
        appendWorkspaceFile,
      } = owner;
      if (
        !listProofWorkspaceDirectory ||
        !workspaceEntryInfo ||
        !deleteProofWorkspaceEntry ||
        !renameWorkspaceEntry ||
        !appendWorkspaceFile
      )
        throw unsupported("entry");
      return use(owner as SessionFsEntryOwnerMethods);
    });
  const info = (relativePath: string) =>
    run((owner) => owner.workspaceEntryInfo({ ...scope, relativePath }));
  const list = async (relativeDir: string) => {
    const listing = await run((owner) =>
      owner.listProofWorkspaceDirectory({ ...scope, relativeDir }),
    );
    // An incomplete listing is never reported as the directory's contents.
    if (listing.truncated) throw unsupported("readdir");
    return listing.entries;
  };

  return {
    async exists(relativePath: string): Promise<boolean> {
      return (await info(relativePath)).kind !== "missing";
    },
    async stat(relativePath: string, display: string): Promise<SessionFsFileInfo> {
      const entry = await info(relativePath);
      if (entry.kind === "missing") throw enoent(display);
      return {
        isFile: entry.kind === "file",
        isDirectory: entry.kind === "directory",
        size: entry.size,
        mtime: new Date(entry.mtimeMs).toISOString(),
        birthtime: new Date(entry.birthtimeMs).toISOString(),
      };
    },
    async readdir(relativeDir: string): Promise<string[]> {
      return (await list(relativeDir)).map((entry) => entry.name);
    },
    async readdirWithTypes(relativeDir: string) {
      return (await list(relativeDir)).map((entry) => ({
        name: entry.name,
        type: entry.directory ? ("directory" as const) : ("file" as const),
      }));
    },
    async rm(relativePath: string, recursive: boolean, force: boolean, display: string) {
      const entry = await info(relativePath);
      if (entry.kind === "missing") {
        if (force) return;
        throw enoent(display);
      }
      if (entry.kind === "other") throw unsupported("rm");
      const directory = entry.kind === "directory";
      if (directory && !recursive && (await list(relativePath)).length > 0)
        throw createErrnoError("ENOTEMPTY", `Directory not empty: ${display}`);
      const result = await run((owner) =>
        owner.deleteProofWorkspaceEntry({ ...scope, relativePath, expectedDirectory: directory }),
      );
      if (result === "notFound" && !force) throw enoent(display);
    },
    /**
     * POSIX rename: an existing regular-file destination is replaced by one
     * atomic rename(2) on the target; a directory destination is `EEXIST`.
     */
    async rename(relativePath: string, destinationPath: string, display: string) {
      const result = await run((owner) =>
        owner.renameWorkspaceEntry({ ...scope, relativePath, destinationPath, replace: true }),
      );
      if (result === "notFound") throw enoent(display);
      if (result === "alreadyExists")
        throw createErrnoError("EEXIST", `Destination exists: ${destinationPath}`);
      if (result !== "done") throw unsupported("rename");
    },
    /**
     * Chunks of at most 48 KiB, in order; a failed chunk leaves a prefix and is
     * never retried. A missing file is created by `create` (Node semantics).
     */
    async appendFile(relativePath: string, content: string, create: () => Promise<void>) {
      const bytes = new TextEncoder().encode(content);
      if ((await info(relativePath)).kind === "missing") return create();
      for (let offset = 0; offset < bytes.byteLength; offset += APPEND_CHUNK) {
        const contents = bytes.subarray(offset, offset + APPEND_CHUNK);
        const result = await run((owner) =>
          owner.appendWorkspaceFile({ ...scope, relativePath, contents }),
        );
        if (result !== "done") throw unsupported("append");
      }
    },
  };
}
