import type { ThreadId } from "@bigbud/contracts";

import {
  mutateRevisionedLedger,
  resolveLedgerStorage,
  subscribeToLedgerChanges,
  type LedgerStorage,
  type LockManagerLike,
} from "../ledger/revisionedLedger";
import {
  MATERIALIZATION_LEDGER_CHANNEL,
  MATERIALIZATION_LEDGER_KEY,
  MATERIALIZATION_LEDGER_MAX_ATTEMPTS,
  readMaterializationLedger as readStoredLedger,
} from "./materializationLedger.storage";
import {
  MaterializationLedgerOverloadedError,
  MaterializationLedgerUnavailableError,
  type MaterializationAttempt,
  type MaterializationAttemptStatus,
  type MaterializationLedger,
  type MaterializationLedgerReadResult,
} from "./materializationLedger.types";

export * from "./materializationLedger.storage";
export * from "./materializationLedger.types";

interface MutationOptions {
  readonly storage?: LedgerStorage | null;
  readonly lockManager?: LockManagerLike | null;
}

function storageFrom(options?: MutationOptions): LedgerStorage | null {
  return options?.storage === undefined ? resolveLedgerStorage() : options.storage;
}

export function readMaterializationLedger(
  storage: LedgerStorage | null = resolveLedgerStorage(),
): MaterializationLedgerReadResult {
  return readStoredLedger(storage);
}

async function mutate<TResult>(
  options: MutationOptions | undefined,
  operation: (
    ledger: MaterializationLedger,
    mutationId: string,
  ) => { readonly ledger: MaterializationLedger; readonly result: TResult },
): Promise<TResult> {
  try {
    return await mutateRevisionedLedger({
      key: MATERIALIZATION_LEDGER_KEY,
      channelName: MATERIALIZATION_LEDGER_CHANNEL,
      storage: storageFrom(options),
      ...(options?.lockManager !== undefined ? { lockManager: options.lockManager } : {}),
      read: readStoredLedger,
      mutate: operation,
    });
  } catch (error) {
    if (error instanceof MaterializationLedgerOverloadedError) throw error;
    throw new MaterializationLedgerUnavailableError(
      error instanceof Error ? error.message : "Materialization ledger is unavailable.",
    );
  }
}

export async function beginMaterializationAttempt(
  input: Omit<MaterializationAttempt, "generation" | "status" | "acceptedSequence">,
  options?: MutationOptions,
): Promise<MaterializationAttempt> {
  return mutate(options, (ledger, mutationId) => {
    if (ledger.attemptsByThreadId[input.threadId]) {
      throw new MaterializationLedgerUnavailableError("An unresolved attempt already exists.");
    }
    if (Object.keys(ledger.attemptsByThreadId).length >= MATERIALIZATION_LEDGER_MAX_ATTEMPTS) {
      throw new MaterializationLedgerOverloadedError(
        "Too many unresolved sends are awaiting reconciliation.",
      );
    }
    const attempt: MaterializationAttempt = {
      ...input,
      generation: ledger.nextGeneration,
      status: "prepared",
      acceptedSequence: null,
    };
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        nextGeneration: ledger.nextGeneration + 1,
        attemptsByThreadId: { ...ledger.attemptsByThreadId, [input.threadId]: attempt },
      },
      result: attempt,
    };
  });
}

export async function setMaterializationAttemptStatus(
  threadId: ThreadId,
  generation: number,
  status: MaterializationAttemptStatus,
  acceptedSequence: number | null = null,
  options?: MutationOptions,
): Promise<boolean> {
  return mutate(options, (ledger, mutationId) => {
    const attempt = ledger.attemptsByThreadId[threadId];
    if (!attempt || attempt.generation !== generation) {
      return {
        ledger: { ...ledger, revision: ledger.revision + 1, lastMutationId: mutationId },
        result: false,
      };
    }
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        attemptsByThreadId: {
          ...ledger.attemptsByThreadId,
          [threadId]: { ...attempt, status, acceptedSequence },
        },
      },
      result: true,
    };
  });
}

export async function clearMaterializationAttempt(
  threadId: ThreadId,
  generation: number,
  options?: MutationOptions,
): Promise<boolean> {
  return mutate(options, (ledger, mutationId) => {
    const attempt = ledger.attemptsByThreadId[threadId];
    if (!attempt || attempt.generation !== generation) {
      return {
        ledger: { ...ledger, revision: ledger.revision + 1, lastMutationId: mutationId },
        result: false,
      };
    }
    const attemptsByThreadId = { ...ledger.attemptsByThreadId };
    delete attemptsByThreadId[threadId];
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        attemptsByThreadId,
      },
      result: true,
    };
  });
}

export async function clearAcceptedMaterializationForCanonicalEvent(
  threadId: ThreadId,
  appliedSequence: number,
  options?: MutationOptions,
): Promise<boolean> {
  const read = readStoredLedger(storageFrom(options));
  if (read.status === "unavailable") {
    throw new MaterializationLedgerUnavailableError(`Ledger unavailable: ${read.reason}`);
  }
  const attempt = read.value.attemptsByThreadId[threadId];
  if (
    !attempt ||
    attempt.status !== "accepted-awaiting-event" ||
    attempt.acceptedSequence === null ||
    attempt.acceptedSequence > appliedSequence
  ) {
    return false;
  }
  return clearMaterializationAttempt(threadId, attempt.generation, options);
}

export async function clearAcceptedMaterializationsThrough(
  appliedSequence: number,
  canonicalThreadIds: ReadonlySet<string>,
  options?: MutationOptions,
): Promise<number> {
  const read = readStoredLedger(storageFrom(options));
  if (read.status === "unavailable") {
    throw new MaterializationLedgerUnavailableError(`Ledger unavailable: ${read.reason}`);
  }
  let cleared = 0;
  for (const attempt of Object.values(read.value.attemptsByThreadId)) {
    if (
      attempt.status === "accepted-awaiting-event" &&
      attempt.acceptedSequence !== null &&
      attempt.acceptedSequence <= appliedSequence &&
      canonicalThreadIds.has(attempt.threadId) &&
      (await clearMaterializationAttempt(attempt.threadId, attempt.generation, options))
    ) {
      cleared += 1;
    }
  }
  return cleared;
}

export function subscribeToMaterializationLedger(listener: (revision: number) => void): () => void {
  return subscribeToLedgerChanges({
    key: MATERIALIZATION_LEDGER_KEY,
    channelName: MATERIALIZATION_LEDGER_CHANNEL,
    listener,
  });
}
