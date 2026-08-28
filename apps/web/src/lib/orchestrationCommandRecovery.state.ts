import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";

import {
  mutateRevisionedLedger,
  resolveLedgerStorage,
  type LedgerStorage,
  type LockManagerLike,
} from "../stores/ledger/revisionedLedger";
import {
  commandIdKey,
  ORCHESTRATION_COMMAND_LEDGER_CHANNEL,
  ORCHESTRATION_COMMAND_LEDGER_KEY,
  ORCHESTRATION_COMMAND_LEDGER_MAX_ATTEMPTS,
  readOrchestrationCommandLedger,
  toPersistedCommandAttempt,
  type OrchestrationCommandLedger,
  type PersistedCommandAttempt,
  type PersistedCommandAttemptStatus,
} from "./orchestrationCommandRecovery.storage";

export interface OrchestrationCommandRecoveryOptions {
  readonly storage?: LedgerStorage | null;
  readonly lockManager?: LockManagerLike | null;
  readonly now?: () => string;
}

export function storageFrom(options?: OrchestrationCommandRecoveryOptions): LedgerStorage | null {
  const storage = options?.storage === undefined ? resolveLedgerStorage() : options.storage;
  if (!storage) return null;
  try {
    storage.getItem(ORCHESTRATION_COMMAND_LEDGER_KEY);
    return storage;
  } catch {
    // Node's experimental localStorage can exist without a usable backing file.
    return null;
  }
}

export function nowFrom(options?: OrchestrationCommandRecoveryOptions): string {
  return options?.now?.() ?? new Date().toISOString();
}

export function mutateLedger<TResult>(
  options: OrchestrationCommandRecoveryOptions | undefined,
  operation: (
    ledger: OrchestrationCommandLedger,
    mutationId: string,
  ) => { readonly ledger: OrchestrationCommandLedger; readonly result: TResult },
): Promise<TResult> {
  const storage = storageFrom(options);
  if (!storage) return Promise.resolve(undefined as TResult);
  return mutateRevisionedLedger({
    key: ORCHESTRATION_COMMAND_LEDGER_KEY,
    channelName: ORCHESTRATION_COMMAND_LEDGER_CHANNEL,
    storage,
    ...(options?.lockManager !== undefined ? { lockManager: options.lockManager } : {}),
    read: readOrchestrationCommandLedger,
    mutate: operation,
  });
}

function updateAttempt(
  ledger: OrchestrationCommandLedger,
  mutationId: string,
  commandId: string,
  update: (attempt: PersistedCommandAttempt) => PersistedCommandAttempt,
) {
  const current = ledger.attemptsByCommandId[commandId];
  if (!current) return { ledger, result: false };
  return {
    ledger: {
      ...ledger,
      revision: ledger.revision + 1,
      lastMutationId: mutationId,
      attemptsByCommandId: {
        ...ledger.attemptsByCommandId,
        [commandId]: update(current),
      },
    },
    result: true,
  };
}

export async function savePendingCommand(
  command: ClientOrchestrationCommand,
  options?: OrchestrationCommandRecoveryOptions,
): Promise<PersistedCommandAttempt> {
  const fallback = toPersistedCommandAttempt({ command, savedAt: nowFrom(options) });
  if (!storageFrom(options)) return fallback;

  return mutateLedger(options, (ledger, mutationId) => {
    const commandId = commandIdKey(command.commandId);
    const existing = ledger.attemptsByCommandId[commandId];
    if (existing) {
      if (existing.commandType !== command.type) {
        throw new Error(`Command ID ${command.commandId} is already used by another command.`);
      }
      return { ledger, result: existing };
    }
    if (
      Object.keys(ledger.attemptsByCommandId).length >= ORCHESTRATION_COMMAND_LEDGER_MAX_ATTEMPTS
    ) {
      throw new Error("Too many unresolved orchestration mutations are awaiting recovery.");
    }
    const attempt = fallback;
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        attemptsByCommandId: { ...ledger.attemptsByCommandId, [commandId]: attempt },
      },
      result: attempt,
    };
  });
}

export async function setAttemptStatus(
  commandId: string,
  status: PersistedCommandAttemptStatus,
  options?: OrchestrationCommandRecoveryOptions,
  acceptedSequence: number | null = null,
  dispatchStartedAt: string | null = null,
): Promise<boolean> {
  if (!storageFrom(options)) return true;
  return mutateLedger(options, (ledger, mutationId) =>
    updateAttempt(ledger, mutationId, commandId, (attempt) => ({
      ...attempt,
      status,
      acceptedSequence,
      dispatchStartedAt,
    })),
  );
}

export async function clearPendingCommand(
  commandId: ClientOrchestrationCommand["commandId"],
  options?: OrchestrationCommandRecoveryOptions,
): Promise<boolean> {
  if (!storageFrom(options)) return false;
  return mutateLedger(options, (ledger, mutationId) => {
    const key = commandIdKey(commandId);
    if (!ledger.attemptsByCommandId[key]) return { ledger, result: false };
    const attemptsByCommandId = { ...ledger.attemptsByCommandId };
    delete attemptsByCommandId[key];
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        attemptsByCommandId,
      },
      result: true,
    };
  });
}

export async function claimPendingCommand(
  commandId: string,
  options?: OrchestrationCommandRecoveryOptions,
): Promise<boolean> {
  if (!storageFrom(options)) return true;
  const now = nowFrom(options);
  return mutateLedger(options, (ledger, mutationId) => {
    const attempt = ledger.attemptsByCommandId[commandId];
    if (!attempt || attempt.status === "accepted-awaiting-event") {
      return { ledger, result: false };
    }
    const dispatchStartedAt = attempt.dispatchStartedAt
      ? Date.parse(attempt.dispatchStartedAt)
      : Number.NaN;
    const leaseActive =
      attempt.status === "dispatching" &&
      Number.isFinite(dispatchStartedAt) &&
      Date.parse(now) - dispatchStartedAt < 30_000;
    if (leaseActive) return { ledger, result: false };
    return updateAttempt(ledger, mutationId, commandId, (current) => ({
      ...current,
      status: "dispatching",
      dispatchStartedAt: now,
      acceptedSequence: null,
    }));
  });
}

export function readAttempt(
  commandId: string,
  options?: OrchestrationCommandRecoveryOptions,
): PersistedCommandAttempt | undefined {
  const storage = storageFrom(options);
  if (!storage) return undefined;
  const ledger = readOrchestrationCommandLedger(storage);
  if (ledger.status === "unavailable") return undefined;
  return ledger.value.attemptsByCommandId[commandId];
}

export function readPendingCommands(
  options?: OrchestrationCommandRecoveryOptions,
): readonly PersistedCommandAttempt[] {
  const storage = storageFrom(options);
  if (!storage) return [];
  const ledger = readOrchestrationCommandLedger(storage);
  return ledger.status === "ready" ? Object.values(ledger.value.attemptsByCommandId) : [];
}
