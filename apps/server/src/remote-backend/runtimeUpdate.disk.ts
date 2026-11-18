/**
 * Activation disk gate (M3 WP-4D; remote agent plan "Migration disk gate").
 *
 * Before any outage the volume holding the database must have room for:
 *   database + WAL   in-place migration growth of the new runtime
 *   backup           the offline `VACUUM INTO` copy (bounded by database + WAL)
 *   staged           bytes of the new graph still to be written (0 once staged)
 *   temp             the rollback restore copy (database + WAL)
 *   reserve          max(256 MiB, 20% of database + WAL)
 * It is checked before drain and re-checked under the maintenance lock right before the backup.
 */
import * as fs from "node:fs/promises";

export const RUNTIME_UPDATE_MIN_RESERVE_BYTES = 256 * 1024 * 1024;

export interface RuntimeUpdateDiskBudget {
  readonly databaseBytes: number;
  readonly walBytes: number;
  readonly backupBytes: number;
  readonly stagedBytes: number;
  readonly tempBytes: number;
  readonly reserveBytes: number;
  readonly requiredBytes: number;
  readonly availableBytes: number;
}

export interface RuntimeUpdateDiskProbe {
  readonly fileSize: (path: string) => Promise<number>;
  readonly availableBytes: (path: string) => Promise<number>;
}

export const nodeRuntimeUpdateDiskProbe: RuntimeUpdateDiskProbe = {
  fileSize: async (path) => {
    try {
      return (await fs.stat(path)).size;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw cause;
    }
  },
  availableBytes: async (path) => {
    const stats = await fs.statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  },
};

export async function estimateRuntimeUpdateDiskBudget(input: {
  readonly dbPath: string;
  readonly stateDir: string;
  readonly stagedBytes?: number;
  readonly probe?: RuntimeUpdateDiskProbe;
}): Promise<RuntimeUpdateDiskBudget> {
  const probe = input.probe ?? nodeRuntimeUpdateDiskProbe;
  const databaseBytes = await probe.fileSize(input.dbPath);
  const walBytes = await probe.fileSize(`${input.dbPath}-wal`);
  const live = databaseBytes + walBytes;
  const reserveBytes = Math.max(RUNTIME_UPDATE_MIN_RESERVE_BYTES, Math.ceil(live * 0.2));
  const stagedBytes = input.stagedBytes ?? 0;
  const budget = {
    databaseBytes,
    walBytes,
    backupBytes: live,
    stagedBytes,
    tempBytes: live,
    reserveBytes,
  };
  return {
    ...budget,
    requiredBytes: live + budget.backupBytes + stagedBytes + budget.tempBytes + reserveBytes,
    availableBytes: await probe.availableBytes(input.stateDir),
  };
}

const mib = (bytes: number) => `${Math.ceil(bytes / (1024 * 1024))} MiB`;

/** A refusal message when the budget does not fit, otherwise null. */
export function runtimeUpdateDiskRefusal(budget: RuntimeUpdateDiskBudget): string | null {
  if (budget.availableBytes >= budget.requiredBytes) return null;
  return (
    `Not enough disk space to update safely: ${mib(budget.requiredBytes)} needed ` +
    `(database and WAL ${mib(budget.databaseBytes + budget.walBytes)}, backup ` +
    `${mib(budget.backupBytes)}, staged runtime ${mib(budget.stagedBytes)}, temporary ` +
    `${mib(budget.tempBytes)}, reserve ${mib(budget.reserveBytes)}), ` +
    `${mib(budget.availableBytes)} available. Nothing was stopped; free space and retry.`
  );
}
