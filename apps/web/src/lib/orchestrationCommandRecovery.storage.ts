import type { ClientOrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import type { CommandId } from "@bigbud/contracts/core/baseSchemas";

import type {
  LedgerReadResult,
  LedgerStorage,
  RevisionedLedger,
} from "../stores/ledger/revisionedLedger";

export const ORCHESTRATION_COMMAND_LEDGER_KEY = "bigbud:orchestration-command-ledger:v2";
export const ORCHESTRATION_COMMAND_LEDGER_CHANNEL = "bigbud:orchestration-command-ledger:v2";
export const ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY = "bigbud:orchestration-command-ledger:v1";
export const ORCHESTRATION_COMMAND_LEDGER_MAX_ATTEMPTS = 64;
export const ORCHESTRATION_COMMAND_LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type PersistedCommandAttemptStatus = "pending" | "dispatching" | "accepted-awaiting-event";

export interface PersistedCommandAttempt {
  readonly commandId: ClientOrchestrationCommand["commandId"];
  readonly commandType: ClientOrchestrationCommand["type"];
  readonly savedAt: string;
  readonly dispatchStartedAt: string | null;
  readonly status: PersistedCommandAttemptStatus;
  readonly acceptedSequence: number | null;
}

export interface OrchestrationCommandLedger extends RevisionedLedger {
  readonly version: 2;
  readonly attemptsByCommandId: Readonly<Record<string, PersistedCommandAttempt>>;
}

export type OrchestrationCommandLedgerReadResult = LedgerReadResult<OrchestrationCommandLedger>;

export const emptyOrchestrationCommandLedger = (): OrchestrationCommandLedger => ({
  version: 2,
  revision: 0,
  lastMutationId: "initial",
  attemptsByCommandId: {},
});

function isAttempt(value: unknown): value is PersistedCommandAttempt {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Record<string, unknown>;
  return (
    typeof attempt.commandId === "string" &&
    attempt.commandId.length > 0 &&
    typeof attempt.commandType === "string" &&
    typeof attempt.savedAt === "string" &&
    (attempt.dispatchStartedAt === null || typeof attempt.dispatchStartedAt === "string") &&
    (attempt.status === "pending" ||
      attempt.status === "dispatching" ||
      attempt.status === "accepted-awaiting-event") &&
    (attempt.acceptedSequence === null || Number.isSafeInteger(attempt.acceptedSequence))
  );
}

export function readOrchestrationCommandLedger(
  storage: LedgerStorage | null,
  now = Date.now(),
): OrchestrationCommandLedgerReadResult {
  if (!storage) return { status: "unavailable", reason: "storage" };

  let raw: string | null;
  try {
    if (storage.getItem(ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY) !== null) {
      if (storage.removeItem) storage.removeItem(ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY);
      else storage.setItem(ORCHESTRATION_COMMAND_LEDGER_LEGACY_KEY, "");
    }
    raw = storage.getItem(ORCHESTRATION_COMMAND_LEDGER_KEY);
  } catch {
    return { status: "unavailable", reason: "storage" };
  }
  if (raw === null) return { status: "ready", value: emptyOrchestrationCommandLedger() };

  try {
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    if (
      candidate.version !== 2 ||
      !Number.isSafeInteger(candidate.revision) ||
      typeof candidate.lastMutationId !== "string" ||
      !candidate.attemptsByCommandId ||
      typeof candidate.attemptsByCommandId !== "object" ||
      Object.values(candidate.attemptsByCommandId).some((attempt) => !isAttempt(attempt))
    ) {
      storage.removeItem?.(ORCHESTRATION_COMMAND_LEDGER_KEY);
      return { status: "ready", value: emptyOrchestrationCommandLedger() };
    }
    const ledger = candidate as unknown as OrchestrationCommandLedger;
    const attemptsByCommandId = Object.fromEntries(
      Object.entries(ledger.attemptsByCommandId).flatMap(([commandId, attempt]) => {
        const savedAt = Date.parse(attempt.savedAt);
        if (
          !Number.isFinite(savedAt) ||
          savedAt > now ||
          now - savedAt > ORCHESTRATION_COMMAND_LEDGER_MAX_AGE_MS
        ) {
          return [];
        }
        return [
          [
            commandId,
            {
              commandId: attempt.commandId,
              commandType: attempt.commandType,
              savedAt: attempt.savedAt,
              dispatchStartedAt: attempt.dispatchStartedAt,
              status: attempt.status,
              acceptedSequence: attempt.acceptedSequence,
            },
          ],
        ];
      }),
    );
    const sanitized: OrchestrationCommandLedger = {
      version: 2,
      revision: ledger.revision,
      lastMutationId: ledger.lastMutationId,
      attemptsByCommandId,
    };
    const serialized = JSON.stringify(sanitized);
    if (serialized !== raw) storage.setItem(ORCHESTRATION_COMMAND_LEDGER_KEY, serialized);
    return { status: "ready", value: sanitized };
  } catch {
    try {
      storage.removeItem?.(ORCHESTRATION_COMMAND_LEDGER_KEY);
    } catch {
      return { status: "unavailable", reason: "storage" };
    }
    return { status: "ready", value: emptyOrchestrationCommandLedger() };
  }
}

export interface PersistedCommandAttemptInput {
  readonly command: ClientOrchestrationCommand;
  readonly savedAt: string;
  readonly dispatchStartedAt?: string | null;
  readonly status?: PersistedCommandAttemptStatus;
  readonly acceptedSequence?: number | null;
}

export function toPersistedCommandAttempt(
  input: PersistedCommandAttemptInput,
): PersistedCommandAttempt {
  return {
    commandId: input.command.commandId,
    commandType: input.command.type,
    savedAt: input.savedAt,
    dispatchStartedAt: input.dispatchStartedAt ?? null,
    status: input.status ?? "pending",
    acceptedSequence: input.acceptedSequence ?? null,
  };
}

export function commandIdKey(commandId: CommandId): string {
  return commandId;
}
