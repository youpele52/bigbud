/**
 * The activation journal (M3 WP-4D): the one durable record that survives the database restore a
 * rollback performs, so it, not the database, carries the activation outcome across restarts.
 *
 * Lives at `<stateDir>/runtime-update/activation-v1.json` (directory 0700, file 0600), written by
 * temp file + fsync + rename + directory fsync. Phases:
 *   restarting      config points at the new graph; the unit restart was requested
 *   rollback        trial failed before any admission; restoring the previous config
 *   restore-pending previous config is back; the next start restores the backup before opening
 *                   the database (idempotent, so an interrupted restore simply repeats)
 *   restored        the backup is the database again; the old runtime settles the operation
 *
 * Its existence keeps public admission closed in whichever runtime starts next.
 */
import { constants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const RUNTIME_UPDATE_JOURNAL_PHASES = [
  "restarting",
  "rollback",
  "restore-pending",
  "restored",
] as const;
export type RuntimeUpdateJournalPhase = (typeof RUNTIME_UPDATE_JOURNAL_PHASES)[number];

export interface RuntimeUpdateJournal {
  readonly revision: 1;
  readonly operationId: string;
  readonly archiveKey: string;
  readonly phase: RuntimeUpdateJournalPhase;
  /** Offline `VACUUM INTO` copy taken after drain, before the restart. */
  readonly backupPath: string;
  /** The exact service config and graph receipt the previous runtime ran with. */
  readonly previousConfig: string;
  readonly previousReceipt: string;
  /** Persisted failure text for the operation once rollback settles it. */
  readonly failure: string | null;
  /** Turns an interrupting update could not confirm as settled. */
  readonly uncertain: ReadonlyArray<string>;
}

export const runtimeUpdateDirectory = (stateDir: string) => join(stateDir, "runtime-update");
export const runtimeUpdateJournalPath = (stateDir: string) =>
  join(runtimeUpdateDirectory(stateDir), "activation-v1.json");
export const runtimeUpdateBackupPath = (stateDir: string, operationId: string) =>
  join(runtimeUpdateDirectory(stateDir), `backup-${operationId}.sqlite`);

/** Synchronous so layer construction can decide the gate's initial state before persistence. */
export const hasRuntimeUpdateJournal = (stateDir: string) =>
  existsSync(runtimeUpdateJournalPath(stateDir));

export async function syncDirectory(path: string) {
  const handle = await fs.open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function ensureRuntimeUpdateDirectory(stateDir: string) {
  const directory = runtimeUpdateDirectory(stateDir);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new Error("The runtime update directory must be a private directory.");
  return directory;
}

/** Atomic private replace: temp + fsync + rename + directory fsync. */
export async function replacePrivateFile(path: string, raw: string | Uint8Array, dir: string) {
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path);
  await syncDirectory(dir);
}

function decode(raw: string): RuntimeUpdateJournal {
  const value = JSON.parse(raw) as Partial<RuntimeUpdateJournal>;
  if (
    value?.revision !== 1 ||
    typeof value.operationId !== "string" ||
    typeof value.archiveKey !== "string" ||
    !RUNTIME_UPDATE_JOURNAL_PHASES.includes(value.phase as RuntimeUpdateJournalPhase) ||
    typeof value.backupPath !== "string" ||
    typeof value.previousConfig !== "string" ||
    typeof value.previousReceipt !== "string" ||
    !(value.failure === null || typeof value.failure === "string") ||
    !Array.isArray(value.uncertain)
  )
    throw new Error("The runtime update journal is invalid; preserve it for repair.");
  return value as RuntimeUpdateJournal;
}

export async function readRuntimeUpdateJournal(
  stateDir: string,
): Promise<RuntimeUpdateJournal | null> {
  try {
    return decode(await fs.readFile(runtimeUpdateJournalPath(stateDir), "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export async function writeRuntimeUpdateJournal(stateDir: string, journal: RuntimeUpdateJournal) {
  const directory = await ensureRuntimeUpdateDirectory(stateDir);
  await replacePrivateFile(
    runtimeUpdateJournalPath(stateDir),
    `${JSON.stringify(journal)}\n`,
    directory,
  );
}

/** Settles the journal and the backup it names; idempotent. */
export async function clearRuntimeUpdateJournal(stateDir: string, journal: RuntimeUpdateJournal) {
  await fs.rm(journal.backupPath, { force: true });
  await fs.rm(runtimeUpdateJournalPath(stateDir), { force: true });
  await syncDirectory(runtimeUpdateDirectory(stateDir)).catch(() => undefined);
}
