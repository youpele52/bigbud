import type { LedgerStorage } from "../ledger/revisionedLedger";
import type {
  MaterializationAttempt,
  MaterializationLedger,
  MaterializationLedgerReadResult,
} from "./materializationLedger.types";

export const MATERIALIZATION_LEDGER_KEY = "bigbud:materialization-ledger:v2";
export const MATERIALIZATION_LEDGER_CHANNEL = "bigbud:materialization-ledger:v2";
export const MATERIALIZATION_LEDGER_MAX_ATTEMPTS = 64;

export const emptyMaterializationLedger = (): MaterializationLedger => ({
  version: 2,
  revision: 0,
  lastMutationId: "initial",
  nextGeneration: 1,
  attemptsByThreadId: {},
});

function isAttempt(value: unknown): value is MaterializationAttempt {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.threadId === "string" &&
    typeof item.projectId === "string" &&
    item.aggregateKind === "thread" &&
    item.aggregateId === item.threadId &&
    typeof item.commandId === "string" &&
    typeof item.messageId === "string" &&
    (item.kind === "turn" || item.kind === "shell") &&
    typeof item.createdAt === "string" &&
    typeof item.requestDigest === "string" &&
    typeof item.serverEpoch === "string" &&
    Number.isSafeInteger(item.ownershipRevision) &&
    Number.isSafeInteger(item.generation) &&
    (item.status === "prepared" ||
      item.status === "dispatching" ||
      item.status === "ambiguous" ||
      item.status === "accepted-awaiting-event") &&
    (item.acceptedSequence === null || Number.isSafeInteger(item.acceptedSequence)) &&
    (item.requiresOutcome === undefined || typeof item.requiresOutcome === "boolean")
  );
}

export function readMaterializationLedger(
  storage: LedgerStorage | null,
): MaterializationLedgerReadResult {
  if (!storage) return { status: "unavailable", reason: "storage" };
  let raw: string | null;
  try {
    raw = storage.getItem(MATERIALIZATION_LEDGER_KEY);
  } catch {
    return { status: "unavailable", reason: "storage" };
  }
  if (raw === null) return { status: "ready", value: emptyMaterializationLedger() };
  try {
    const candidate = JSON.parse(raw) as Record<string, unknown>;
    if (
      candidate.version !== 2 ||
      !Number.isSafeInteger(candidate.revision) ||
      typeof candidate.lastMutationId !== "string" ||
      !Number.isSafeInteger(candidate.nextGeneration) ||
      !candidate.attemptsByThreadId ||
      typeof candidate.attemptsByThreadId !== "object" ||
      Object.values(candidate.attemptsByThreadId).some((attempt) => !isAttempt(attempt))
    ) {
      return { status: "unavailable", reason: "corrupt" };
    }
    return { status: "ready", value: candidate as unknown as MaterializationLedger };
  } catch {
    return { status: "unavailable", reason: "corrupt" };
  }
}
