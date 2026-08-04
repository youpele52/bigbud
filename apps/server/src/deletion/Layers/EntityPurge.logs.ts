import * as nodeFs from "node:fs/promises";

import { toSafeThreadAttachmentSegment } from "../../attachments/attachmentStore.ts";
import { legacySafeThreadId, toSafeThreadId } from "../../terminal/Layers/Manager.shell.ts";

function providerLogNames(entries: ReadonlyArray<string>, threadId: string): ReadonlyArray<string> {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (!segment) throw new Error("provider-log thread segment is invalid");
  const base = `${segment}.log`;
  return entries.filter((entry) => entry === base || entry.startsWith(`${base}.`));
}

function terminalHistoryNames(
  entries: ReadonlyArray<string>,
  threadId: string,
): ReadonlyArray<string> {
  const current = `${toSafeThreadId(threadId)}.log`;
  const currentPrefix = `${toSafeThreadId(threadId)}_`;
  const legacy = `${legacySafeThreadId(threadId)}.log`;
  return entries.filter(
    (entry) => entry === current || entry === legacy || entry.startsWith(currentPrefix),
  );
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export async function readOwnedLogDirectory(directory: string): Promise<ReadonlyArray<string>> {
  return nodeFs.readdir(directory).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
}

export async function verifyOwnedLogsAbsent(input: {
  readonly providerDirectory: string;
  readonly terminalDirectory: string;
  readonly knownThreadIds: ReadonlyArray<string>;
  readonly threadId: string;
}): Promise<void> {
  for (const [directory, type] of [
    [input.providerDirectory, "provider"],
    [input.terminalDirectory, "terminal"],
  ] as const) {
    const entries = await readOwnedLogDirectory(directory);
    if (exclusiveOwnedLogNames({ ...input, entries, type }).length > 0) {
      throw new Error(`${type} log appeared or remained after purge`);
    }
  }
}

export function exclusiveOwnedLogNames(input: {
  readonly entries: ReadonlyArray<string>;
  readonly knownThreadIds: ReadonlyArray<string>;
  readonly threadId: string;
  readonly type: "provider" | "terminal";
}): ReadonlyArray<string> {
  const resolve = input.type === "provider" ? providerLogNames : terminalHistoryNames;
  const owned = resolve(input.entries, input.threadId);
  for (const otherId of input.knownThreadIds) {
    if (
      otherId !== input.threadId &&
      resolve(input.entries, otherId).some((name) => owned.includes(name))
    ) {
      throw new Error(`${input.type} log ownership is ambiguous`);
    }
  }
  return owned;
}

export function assertOwnedLogName(input: {
  readonly entries: ReadonlyArray<string>;
  readonly knownThreadIds: ReadonlyArray<string>;
  readonly relativePath: string;
  readonly threadId: string;
  readonly type: "provider" | "terminal";
}): void {
  const entries = input.entries.includes(input.relativePath)
    ? input.entries
    : [...input.entries, input.relativePath];
  if (!exclusiveOwnedLogNames({ ...input, entries }).includes(input.relativePath)) {
    throw new Error(`${input.type} log ownership changed`);
  }
}
