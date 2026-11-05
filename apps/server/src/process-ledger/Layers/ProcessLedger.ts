/**
 * ProcessLedgerLive - records tracked children under `<stateDir>/process-ledger/` and, once per
 * startup in the background, reaps the children of dead backends (see `ProcessLedger.reap.ts`).
 *
 * Requires `BackendInstance`: holding the state directory lock is what makes other owners' records
 * judgeable, and the lock's identity is the owner identity written into every record.
 *
 * @module ProcessLedgerLive
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { processStartTokenAsync } from "@bigbud/shared/processStartToken";
import { Effect, Layer } from "effect";

import { BackendInstance, type BackendInstanceShape } from "../../startup/backendInstance.ts";
import { ServerConfig } from "../../startup/config.ts";
import { processAlive, processGroupAlive } from "../../utils/processGroup.ts";
import {
  decideProcessLedgerRecord,
  killProcessLedgerTargets,
  type ProcessLedgerKillTargets,
} from "../ProcessLedger.reap.ts";
import {
  encodeProcessLedgerRecord,
  makeProcessLedgerRecord,
  parseProcessLedgerRecord,
  PROCESS_LEDGER_DIRNAME,
  type ProcessLedgerOwner,
  type ProcessLedgerRecord,
  processLedgerRecordPath,
} from "../ProcessLedger.record.ts";
import { readProcessTable } from "../ProcessLedger.snapshot.ts";
import {
  NOOP_PROCESS_LEDGER_TICKET,
  ProcessLedger,
  type ProcessLedgerShape,
  type ProcessLedgerTrackInput,
} from "../Services/ProcessLedger.ts";

const ownerOf = (backend: BackendInstanceShape): ProcessLedgerOwner => ({
  nonce: backend.nonce,
  pid: backend.pid,
  startedAt: backend.startedAt,
  hostname: backend.hostname,
  machineId: backend.machineId,
});

const childStillRunning = (input: Pick<ProcessLedgerTrackInput, "pid" | "kill">) =>
  input.kill === "group" ? processGroupAlive(input.pid) : processAlive(input.pid);

export function makeProcessLedger(input: {
  readonly dir: string;
  readonly owner: ProcessLedgerOwner;
}): ProcessLedgerShape {
  let dirReady: Promise<void> | undefined;
  const ensureDir = () =>
    (dirReady ??= fs.mkdir(input.dir, { recursive: true, mode: 0o700 }).then(
      () => undefined,
      (cause: unknown) => {
        dirReady = undefined;
        throw cause;
      },
    ));

  const release = (file: string, child: ProcessLedgerTrackInput) =>
    Effect.gen(function* () {
      if (childStillRunning(child)) {
        // The release could not stop it; the next startup's reaper still can.
        yield* Effect.logWarning("Tracked provider process outlived its release; keeping record", {
          pid: child.pid,
          label: child.label,
        });
        return;
      }
      yield* Effect.promise(() => fs.rm(file, { force: true }).catch(() => undefined));
    });

  return {
    track: (child) =>
      Effect.tryPromise(async () => {
        if (process.platform === "win32") return NOOP_PROCESS_LEDGER_TICKET;
        const file = processLedgerRecordPath(input.dir, input.owner.nonce, child.pid);
        // Without a start token the child's identity is unprovable later: never record it.
        const startToken = file ? await processStartTokenAsync(child.pid) : undefined;
        if (!file || !startToken) return NOOP_PROCESS_LEDGER_TICKET;
        const record = makeProcessLedgerRecord({
          owner: input.owner,
          pid: child.pid,
          startToken,
          command: child.command,
          args: [...child.args],
          kill: child.kill,
          label: child.label,
        });
        await ensureDir();
        const temp = `${file}.tmp`;
        await fs.writeFile(temp, encodeProcessLedgerRecord(record), { mode: 0o600 });
        await fs.rename(temp, file);
        return { release: release(file, child) };
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not record provider process in the ledger", {
            pid: child.pid,
            label: child.label,
            cause,
          }).pipe(Effect.as(NOOP_PROCESS_LEDGER_TICKET)),
        ),
      ),
  };
}

interface LedgerFile {
  readonly file: string;
  readonly record: ProcessLedgerRecord | undefined;
}

const readLedgerFiles = async (dir: string, selfNonce: string): Promise<LedgerFile[]> => {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const files: LedgerFile[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith(".tmp")) {
      // A dead owner's interrupted write; this backend's own are still in flight.
      if (!name.startsWith(`${selfNonce}.`)) await fs.rm(file, { force: true }).catch(() => {});
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const raw = await fs.readFile(file, "utf8").catch(() => undefined);
    files.push({ file, record: raw === undefined ? undefined : parseProcessLedgerRecord(raw) });
  }
  return files;
};

const removeFile = (file: string) =>
  Effect.promise(() => fs.rm(file, { force: true }).catch(() => undefined));

/** Kill the recorded children of dead backends; see `ProcessLedger.reap.ts` for the proof rules. */
export const reapOrphanedProcesses = Effect.fn("ProcessLedger.reapOrphanedProcesses")(function* (
  dir: string,
  backend: BackendInstanceShape,
) {
  if (process.platform === "win32") return;
  const files = yield* Effect.promise(() => readLedgerFiles(dir, backend.nonce));
  const records = files.flatMap(({ file, record }) => (record ? [{ file, record }] : []));
  // Unreadable records name nothing provable; drop them so they do not accumulate.
  yield* Effect.forEach(
    files.filter((entry) => !entry.record),
    (entry) => removeFile(entry.file),
  );
  if (records.length === 0) return;

  const table = yield* Effect.promise(readProcessTable);
  if (!table) {
    yield* Effect.logWarning("Process table unavailable; orphan reaping skipped this startup");
    return;
  }
  // Once per owner, not per record: classifying may run a synchronous `ps` for a live owner PID.
  const ownerStates = new Map<string, ReturnType<BackendInstanceShape["classifyOwner"]>>();
  const classifyOwner: BackendInstanceShape["classifyOwner"] = (owner) => {
    const key = JSON.stringify([owner.pid, owner.startedAt, owner.hostname, owner.machineId]);
    const known = ownerStates.get(key);
    if (known) return known;
    const state = backend.classifyOwner(owner);
    ownerStates.set(key, state);
    return state;
  };
  const counts = { dropped: 0, kept: 0, killed: 0, survived: 0 };
  const kills: Array<{ readonly file: string; readonly targets: ProcessLedgerKillTargets }> = [];
  for (const { file, record } of records) {
    const decision = decideProcessLedgerRecord(record, {
      selfNonce: backend.nonce,
      classifyOwner,
      table,
    });
    if (decision.action === "keep") counts.kept += 1;
    else if (decision.action === "drop") {
      counts.dropped += 1;
      yield* removeFile(file);
    } else kills.push({ file, targets: decision.targets });
  }

  if (kills.length > 0) {
    // Re-prove lock ownership right before acting on "the owner is dead".
    const held = yield* Effect.tryPromise(backend.assertHeld).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!held) {
      yield* Effect.logWarning("Backend lock no longer held; orphan reaping aborted");
      return;
    }
    const dead = yield* killProcessLedgerTargets(kills.map((entry) => entry.targets));
    for (const [index, { file }] of kills.entries()) {
      if (dead[index]) {
        counts.killed += 1;
        yield* removeFile(file);
      } else counts.survived += 1;
    }
  }
  yield* Effect.logInfo("Process ledger startup reap finished", counts);
});

export const ProcessLedgerLive = Layer.effect(
  ProcessLedger,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const backend = yield* BackendInstance;
    const dir = path.join(config.stateDir, PROCESS_LEDGER_DIRNAME);
    // In the background: startup never waits on signals or exit polling.
    yield* Effect.forkScoped(
      reapOrphanedProcesses(dir, backend).pipe(Effect.ignoreCause({ log: true })),
    );
    return makeProcessLedger({ dir, owner: ownerOf(backend) });
  }),
);
