import * as fs from "node:fs/promises";
import { Schema } from "effect";

import { ensurePrivateDirectory, writeFileAtomic } from "./localTerminalHost.fs.ts";
import type { LocalTerminalHostPaths } from "./localTerminalHost.paths.ts";

/**
 * One record per generation. Records exist ONLY to verify a PID before signalling it; they never
 * decide compatibility (that comes from the hello). A provisional `launching` record without a
 * PID is written before launch so a crash between launch and the final write stays visible.
 */
export const LocalTerminalHostRecordSchema = Schema.Struct({
  generation: Schema.Number,
  state: Schema.Literals(["launching", "running", "draining"]),
  binaryPath: Schema.String,
  agentVersion: Schema.optional(Schema.String),
  buildDigest: Schema.optional(Schema.String),
  protocolMajor: Schema.optional(Schema.Number),
  protocolMinor: Schema.optional(Schema.Number),
  capabilities: Schema.Array(Schema.String),
  epoch: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  /** Unix milliseconds, from the hello (R4) or `LC_ALL=C ps -o lstart=`. */
  pidStartTime: Schema.optional(Schema.Number),
  launchedAt: Schema.Number,
  /** The one-time amber "Close them" notice was already raised for this generation. */
  drainingNoticeRaised: Schema.optional(Schema.Boolean),
});
export type LocalTerminalHostRecord = typeof LocalTerminalHostRecordSchema.Type;

const HostsFileSchema = Schema.Struct({
  version: Schema.Literal(1),
  hosts: Schema.Array(LocalTerminalHostRecordSchema),
});

const MAX_RECORDS = 64;
const MAX_FILE_BYTES = 256 * 1024;

export interface LocalTerminalHostRegistry {
  readonly read: () => Promise<ReadonlyArray<LocalTerminalHostRecord>>;
  readonly update: (
    transition: (
      records: ReadonlyArray<LocalTerminalHostRecord>,
    ) => ReadonlyArray<LocalTerminalHostRecord>,
  ) => Promise<ReadonlyArray<LocalTerminalHostRecord>>;
}

function validRecord(record: LocalTerminalHostRecord): boolean {
  return (
    Number.isSafeInteger(record.generation) &&
    record.generation >= 1 &&
    (record.pid === undefined || (Number.isSafeInteger(record.pid) && record.pid > 1)) &&
    record.capabilities.length <= 256
  );
}

export function parseLocalTerminalHostRecords(
  text: string,
): ReadonlyArray<LocalTerminalHostRecord> {
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error("hosts.json is too large.");
  const decoded = Schema.decodeUnknownSync(HostsFileSchema)(JSON.parse(text));
  const hosts = decoded.hosts.filter(validRecord);
  if (new Set(hosts.map((record) => record.generation)).size !== hosts.length)
    throw new Error("hosts.json has duplicate generations.");
  return hosts;
}

/** Writes are serialized in-process and atomic on disk (`0600`). */
export function makeLocalTerminalHostRegistry(
  paths: LocalTerminalHostPaths,
  onCorrupt: (error: unknown) => void = () => {},
): LocalTerminalHostRegistry {
  let tail: Promise<unknown> = Promise.resolve();
  const serialized = <A>(run: () => Promise<A>): Promise<A> => {
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  };
  const readUnlocked = async (): Promise<ReadonlyArray<LocalTerminalHostRecord>> => {
    let text: string;
    try {
      text = await fs.readFile(paths.hostsFile, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    try {
      return parseLocalTerminalHostRecords(text);
    } catch (cause) {
      // A lost record only makes PIDs unverifiable, which keeps hosts alive (unknown = live).
      onCorrupt(cause);
      return [];
    }
  };
  return {
    read: () => serialized(readUnlocked),
    update: (transition) =>
      serialized(async () => {
        const before = await readUnlocked();
        const next = [...transition(before)]
          .filter(validRecord)
          .toSorted((left, right) => left.generation - right.generation)
          .slice(-MAX_RECORDS);
        await ensurePrivateDirectory(paths.root);
        await writeFileAtomic(
          paths.hostsFile,
          `${JSON.stringify({ version: 1, hosts: next }, null, 2)}\n`,
          0o600,
        );
        return next;
      }),
  };
}

export function upsertLocalTerminalHostRecord(
  records: ReadonlyArray<LocalTerminalHostRecord>,
  record: LocalTerminalHostRecord,
): ReadonlyArray<LocalTerminalHostRecord> {
  return [...records.filter((current) => current.generation !== record.generation), record];
}

export function removeLocalTerminalHostRecord(
  records: ReadonlyArray<LocalTerminalHostRecord>,
  generation: number,
): ReadonlyArray<LocalTerminalHostRecord> {
  return records.filter((record) => record.generation !== generation);
}
