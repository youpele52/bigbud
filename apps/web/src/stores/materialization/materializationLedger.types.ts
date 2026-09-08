import type { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";

export type MaterializationAttemptStatus =
  | "prepared"
  | "dispatching"
  | "ambiguous"
  | "accepted-awaiting-event";

export interface MaterializationAttempt {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly aggregateKind: "thread";
  readonly aggregateId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly kind: "turn" | "shell";
  readonly createdAt: string;
  readonly requestDigest: string;
  readonly serverEpoch: string;
  readonly ownershipRevision: number;
  readonly generation: number;
  readonly status: MaterializationAttemptStatus;
  readonly acceptedSequence: number | null;
  readonly requiresOutcome?: boolean;
}

export interface MaterializationLedger {
  readonly version: 2;
  readonly revision: number;
  readonly lastMutationId: string;
  readonly nextGeneration: number;
  readonly attemptsByThreadId: Readonly<Record<string, MaterializationAttempt>>;
}

export type MaterializationLedgerReadResult =
  | { readonly status: "ready"; readonly value: MaterializationLedger }
  | { readonly status: "unavailable"; readonly reason: "corrupt" | "storage" };

export class MaterializationLedgerUnavailableError extends Error {
  readonly code = "materialization_ledger_unavailable";
}

export class MaterializationLedgerOverloadedError extends Error {
  readonly code = "materialization_ledger_overloaded";
}
