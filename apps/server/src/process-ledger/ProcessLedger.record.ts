/**
 * On-disk process ledger records: one JSON file per tracked child, named by owner nonce and PID,
 * written atomically (temp file + rename) so readers never see a partial record.
 *
 * @module ProcessLedger.record
 */
import * as path from "node:path";

import { Option, Schema } from "effect";

export const PROCESS_LEDGER_DIRNAME = "process-ledger";
const PROCESS_LEDGER_FORMAT = "bigbud.process-ledger.v1";

/**
 * How a reaper may stop the child:
 * - `group`: the child leads its own process group (spawned detached), so signalling the group
 *   reaches its MCP servers and workers too.
 * - `tree`: the child shares a group with unrelated processes (for example the desktop app), so
 *   only the child and its descendants by parent PID may be signalled; never the group.
 */
export type ProcessLedgerKillMode = "group" | "tree";

const ProcessLedgerOwner = Schema.Struct({
  nonce: Schema.String,
  pid: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
  hostname: Schema.String,
  machineId: Schema.NullOr(Schema.String),
});
export type ProcessLedgerOwner = typeof ProcessLedgerOwner.Type;

const ProcessLedgerRecord = Schema.Struct({
  format: Schema.Literal(PROCESS_LEDGER_FORMAT),
  owner: ProcessLedgerOwner,
  pid: Schema.Number,
  startToken: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  kill: Schema.Literals(["group", "tree"]),
  label: Schema.String,
  recordedAt: Schema.String,
});
export type ProcessLedgerRecord = typeof ProcessLedgerRecord.Type;

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ProcessLedgerRecord));

export function makeProcessLedgerRecord(
  input: Omit<ProcessLedgerRecord, "format" | "recordedAt">,
  now: Date = new Date(),
): ProcessLedgerRecord {
  return { format: PROCESS_LEDGER_FORMAT, ...input, recordedAt: now.toISOString() };
}

export function encodeProcessLedgerRecord(record: ProcessLedgerRecord): string {
  return `${JSON.stringify(record)}\n`;
}

export function parseProcessLedgerRecord(raw: string): ProcessLedgerRecord | undefined {
  return Option.getOrUndefined(decodeRecord(raw));
}

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** `<dir>/<owner nonce>.<pid>.json`; undefined for a nonce that is not a plain file-name token. */
export function processLedgerRecordPath(
  dir: string,
  ownerNonce: string,
  pid: number,
): string | undefined {
  if (!SAFE_NAME.test(ownerNonce) || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return path.join(dir, `${ownerNonce}.${pid}.json`);
}

/**
 * Whether the command line observed now still belongs to the recorded spawn. Wrappers may `exec`
 * another program (Cursor's `agent` script execs node with extra leading arguments), so argv[0]
 * and the leading arguments can change; the recorded arguments must still end the command line.
 * With no recorded arguments the executable's base name must match instead.
 */
export function commandLineMatches(
  record: Pick<ProcessLedgerRecord, "command" | "args">,
  observed: string,
): boolean {
  const line = observed.trim();
  if (record.args.length === 0) {
    const argv0 = line.split(/\s+/, 1)[0] ?? "";
    return path.basename(argv0) === path.basename(record.command);
  }
  const suffix = record.args.join(" ");
  return line === suffix || line.endsWith(` ${suffix}`);
}
