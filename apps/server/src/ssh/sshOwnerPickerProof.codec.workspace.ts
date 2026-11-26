import { posix } from "node:path";

import { decodeMessage, WireWriter } from "../remote-agent/remoteAgentProtocol.codec.wire.ts";
import {
  boolValue,
  bytesValue,
  EMPTY,
  invalid,
  PickerProofOwnerError,
  uintValue,
} from "./sshOwnerPickerProof.codec.wire.ts";

const MAX_PATH_BYTES = 4_096;
const MAX_RANGE_BYTES = 512 * 1024;
const MAX_INDEX_ENTRIES = 25_000;
export const MAX_WORKSPACE_WRITE_BYTES = 48 * 1024;
const MAX_CONTENT_SEARCH_QUERY_BYTES = 4_096;
// Match the public workspace search contract and bound the private owner reply independently.
const MAX_CONTENT_SEARCH_MATCHES = 100;
const workspacePathDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface WorkspaceRoot {
  readonly workspaceRoot: string;
}

interface WorkspacePaths extends WorkspaceRoot {
  readonly relativePath: string;
}

type WorkspaceRead =
  | { readonly kind: "preview" }
  | { readonly kind: "range"; readonly offset: number; readonly maxBytes: number };

export type PickerProofWorkspaceReadInput = WorkspacePaths &
  WorkspaceRead & { readonly executionTargetId: string };

export type ProofWorkspaceReadOperation = WorkspacePaths & {
  readonly kind: "proofWorkspaceRead";
  readonly read: WorkspaceRead;
};

export interface PickerProofWorkspaceFile {
  readonly data: Uint8Array;
  readonly sizeBytes: number;
  readonly truncated: boolean;
  readonly sha256?: string;
}

interface WorkspaceDirectoryPaths extends WorkspaceRoot {
  readonly relativeDir: string;
}

export interface PickerProofWorkspaceListInput extends WorkspaceDirectoryPaths {
  readonly executionTargetId: string;
}

export interface ProofWorkspaceListOperation extends WorkspaceDirectoryPaths {
  readonly kind: "proofWorkspaceList";
}

export interface ProofWorkspaceSnapshotOperation extends WorkspaceDirectoryPaths {
  readonly kind: "proofWorkspaceSnapshot";
}

export interface PickerProofWorkspaceIndexInput extends WorkspaceRoot {
  readonly executionTargetId: string;
}

export interface ProofWorkspaceIndexOperation extends WorkspaceRoot {
  readonly kind: "proofWorkspaceIndex";
}

export interface PickerProofWorkspaceWriteInput extends WorkspacePaths {
  readonly executionTargetId: string;
  readonly contents: Uint8Array;
}

export interface ProofWorkspaceWriteOperation extends WorkspacePaths {
  readonly kind: "proofWorkspaceWrite" | "proofWorkspaceCreate";
  readonly contents: Uint8Array;
}

export interface PickerProofWorkspaceIndex {
  readonly entries: ReadonlyArray<{ readonly path: string; readonly directory: boolean }>;
  readonly truncated: boolean;
}

interface WorkspaceContentSearch extends WorkspaceRoot {
  readonly query: string;
  readonly limit: number;
}

export interface PickerProofWorkspaceContentSearchInput extends WorkspaceContentSearch {
  readonly executionTargetId: string;
}

export interface ProofWorkspaceContentSearchOperation extends WorkspaceContentSearch {
  readonly kind: "proofWorkspaceContentSearch";
}

interface ProofWorkspaceMatch {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
  readonly lineText: string;
}

export interface PickerProofWorkspaceContentMatches {
  readonly matches: ReadonlyArray<ProofWorkspaceMatch>;
  readonly truncated: boolean;
}

interface WorkspaceChild {
  readonly name: string;
  readonly directory: boolean;
}

export interface PickerProofWorkspaceDirectory {
  readonly entries: readonly WorkspaceChild[];
  readonly truncated: boolean;
}

const validPathOperand = (path: string) =>
  path.length > 0 && !path.includes("\0") && Buffer.byteLength(path) <= MAX_PATH_BYTES;
const normalComponent = (part: string) => part.length > 0 && part !== "." && part !== "..";
const hasDrivePrefix = (path: string) => /^[a-z]:/i.test(path);
// UTF-8 encoding would silently replace an unpaired UTF-16 surrogate.
const hasUnpairedSurrogate = (path: string) => /[\uD800-\uDFFF]/u.test(path);

const normalRelativePath = (path: string) =>
  validPathOperand(path) && !hasUnpairedSurrogate(path) && path.split("/").every(normalComponent);
export const validRelativeOperand = (path: string) =>
  normalRelativePath(path) && !path.startsWith("\\") && !hasDrivePrefix(path);

export function writeWorkspaceRoot(
  writer: WireWriter,
  { workspaceRoot }: WorkspaceRoot,
  field = 1,
) {
  // Keep the exact root binding; the owner authorizes it.
  if (
    typeof workspaceRoot !== "string" ||
    !validPathOperand(workspaceRoot) ||
    !posix.isAbsolute(workspaceRoot) ||
    hasUnpairedSurrogate(workspaceRoot)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writer.fieldString(field, workspaceRoot);
}

export function clampWorkspaceContentSearchLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new PickerProofOwnerError("invalidOperands");
  return Math.min(limit, MAX_CONTENT_SEARCH_MATCHES);
}

export function writeWorkspaceContentSearch(writer: WireWriter, operation: WorkspaceContentSearch) {
  const { query, limit } = operation;
  if (
    typeof query !== "string" ||
    !query ||
    query.includes("\0") ||
    Buffer.byteLength(query) > MAX_CONTENT_SEARCH_QUERY_BYTES ||
    hasUnpairedSurrogate(query)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writeWorkspaceRoot(writer, operation);
  writer.fieldString(2, query);
  writer.fieldUint(3, clampWorkspaceContentSearchLimit(limit));
}

export function writeWorkspaceList(writer: WireWriter, operation: WorkspaceDirectoryPaths) {
  const { relativeDir } = operation;
  // An empty relative directory selects the bound root.
  if (
    typeof relativeDir !== "string" ||
    (relativeDir !== "" && !validRelativeOperand(relativeDir))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writeWorkspaceRoot(writer, operation);
  writer.fieldString(2, relativeDir);
}

export function isWorkspaceWriteContents(contents: unknown): contents is Uint8Array {
  return contents instanceof Uint8Array && contents.byteLength <= MAX_WORKSPACE_WRITE_BYTES;
}

export function writeWorkspaceWrite(writer: WireWriter, operation: ProofWorkspaceWriteOperation) {
  const { relativePath, contents } = operation;
  if (
    typeof relativePath !== "string" ||
    !validRelativeOperand(relativePath) ||
    !isWorkspaceWriteContents(contents)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writeWorkspaceRoot(writer, operation);
  writer.fieldString(2, relativePath);
  writer.fieldBytes(3, contents);
}

export function readWorkspaceSnapshot(bytes: Uint8Array): string {
  let digest: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (digest !== undefined) return invalid();
      digest = decodeWorkspaceString(bytesValue(wire, reader));
    } else reader.skip(wire);
  });
  if (!digest || /[^0-9a-f]/.test(digest)) return invalid();
  return digest;
}

export function readWorkspaceIndex(bytes: Uint8Array): PickerProofWorkspaceIndex {
  const entries: Array<PickerProofWorkspaceIndex["entries"][number]> = [];
  const paths = new Set<string>();
  let truncated: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (entries.length === MAX_INDEX_ENTRIES) return invalid();
      const { name: path, directory } = readWorkspaceEntry(bytesValue(wire, reader));
      // Index paths are POSIX names; keep literal characters rather than rewriting them.
      if (!normalRelativePath(path) || paths.has(path)) return invalid();
      paths.add(path);
      entries.push({ path, directory });
    } else if (field === 2) {
      if (truncated !== undefined) return invalid();
      truncated = boolValue(wire, reader);
    } else reader.skip(wire);
  });
  return { entries, truncated: truncated ?? false };
}

function decodeWorkspaceString(bytes: Uint8Array): string {
  try {
    return workspacePathDecoder.decode(bytes);
  } catch {
    return invalid();
  }
}

function readWorkspaceMatch(bytes: Uint8Array): ProofWorkspaceMatch {
  let path: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  let lineText: string | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (path !== undefined) return invalid();
      path = decodeWorkspaceString(bytesValue(wire, reader));
    } else if (field === 2) {
      if (line !== undefined) return invalid();
      line = uintValue(wire, reader);
    } else if (field === 3) {
      if (column !== undefined) return invalid();
      column = uintValue(wire, reader);
      if (column === 0 || column > 0xffff_ffff) return invalid();
    } else if (field === 4) {
      if (lineText !== undefined) return invalid();
      lineText = decodeWorkspaceString(bytesValue(wire, reader));
    } else reader.skip(wire);
  });
  if (path === undefined || !validRelativeOperand(path) || line === undefined || line === 0)
    return invalid();
  return { path, line, ...(column === undefined ? {} : { column }), lineText: lineText ?? "" };
}

export function readWorkspaceContentMatches(bytes: Uint8Array): PickerProofWorkspaceContentMatches {
  const matches: ProofWorkspaceMatch[] = [];
  let truncated: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (matches.length === MAX_CONTENT_SEARCH_MATCHES) return invalid();
      matches.push(readWorkspaceMatch(bytesValue(wire, reader)));
    } else if (field === 2) {
      if (truncated !== undefined) return invalid();
      truncated = boolValue(wire, reader);
    } else reader.skip(wire);
  });
  return { matches, truncated: truncated ?? false };
}

function readWorkspaceEntry(bytes: Uint8Array): WorkspaceChild {
  let name: string | undefined;
  let directory: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      if (name !== undefined) return invalid();
      name = decodeWorkspaceString(bytesValue(wire, reader));
    } else if (field === 2) {
      if (directory !== undefined) return invalid();
      directory = boolValue(wire, reader);
    } else reader.skip(wire);
  });
  if (name === undefined) return invalid();
  return { name, directory: directory ?? false };
}

export function readWorkspaceDirectory(bytes: Uint8Array): PickerProofWorkspaceDirectory {
  const entries: WorkspaceChild[] = [];
  const names = new Set<string>();
  let truncated: boolean | undefined;
  decodeMessage(bytes, (field, wire, reader) => {
    if (field === 1) {
      const entry = readWorkspaceEntry(bytesValue(wire, reader));
      const { name } = entry;
      if (!normalComponent(name) || name.includes("/") || name.includes("\0") || names.has(name))
        return invalid();
      names.add(entry.name);
      entries.push(entry);
    } else if (field === 2) {
      if (truncated !== undefined) return invalid();
      truncated = boolValue(wire, reader);
    } else reader.skip(wire);
  });
  return { entries, truncated: truncated ?? false };
}

export function writeWorkspaceRead(writer: WireWriter, operation: ProofWorkspaceReadOperation) {
  const { workspaceRoot, relativePath, read } = operation;
  // The owner, not the client, authorizes and resolves the remote relative path.
  if (
    !validPathOperand(workspaceRoot) ||
    !posix.isAbsolute(workspaceRoot) ||
    !validPathOperand(relativePath)
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  writer.fieldString(1, workspaceRoot);
  writer.fieldString(2, relativePath);
  switch (read.kind) {
    case "preview":
      writer.fieldRepeatedMessage(3, EMPTY);
      break;
    case "range": {
      const { offset, maxBytes } = read;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > MAX_RANGE_BYTES
      ) {
        throw new PickerProofOwnerError("invalidOperands");
      }
      const range = new WireWriter();
      range.fieldUint(1, offset);
      range.fieldUint(2, maxBytes);
      writer.fieldRepeatedMessage(4, range.finish());
      break;
    }
    default:
      throw new PickerProofOwnerError("invalidOperands");
  }
}
