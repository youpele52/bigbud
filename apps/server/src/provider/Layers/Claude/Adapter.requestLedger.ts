import type { ElicitationResult, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalRequestId,
  CanonicalRequestType,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@bigbud/contracts";
import type { Deferred } from "effect";

export const REQUEST_LEDGER_LIMIT = 500;

export interface NativeRequestIdentity {
  readonly providerRequestId?: string;
  readonly providerAgentId?: string;
  readonly providerItemId?: string;
}

export interface PendingApprovalLedgerEntry extends NativeRequestIdentity {
  readonly kind: "approval";
  readonly state: "pending";
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<unknown>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly completion: Deferred.Deferred<void>;
  uiDecision?: ProviderApprovalDecision;
}

export interface ResolvedApprovalLedgerEntry extends NativeRequestIdentity {
  readonly kind: "approval";
  readonly state: "resolved";
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly resolvedAt: string;
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly decision: ProviderApprovalDecision;
  readonly suggestions: ReadonlyArray<unknown>;
  readonly result?: PermissionResult;
  readonly sessionPermissionApplied: boolean;
}

export interface PendingUserInputLedgerEntry extends NativeRequestIdentity {
  readonly kind: "user-input";
  readonly state: "pending";
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly completion: Deferred.Deferred<void>;
  cancelled: boolean;
  readonly sensitive?: boolean;
  uiAnswers?: ProviderUserInputAnswers;
}

export interface ResolvedUserInputLedgerEntry extends NativeRequestIdentity {
  readonly kind: "user-input";
  readonly state: "resolved";
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly resolvedAt: string;
  readonly answers: ProviderUserInputAnswers;
  readonly result?: PermissionResult;
  readonly elicitationResult?: ElicitationResult;
  readonly sensitive?: boolean;
}

export type ResolvingClaudeRequestLedgerEntry = (
  | Omit<PendingApprovalLedgerEntry, "state">
  | Omit<PendingUserInputLedgerEntry, "state">
) & { readonly state: "resolving"; cancelled: boolean };

export type ResolvedClaudeRequestLedgerEntry =
  | ResolvedApprovalLedgerEntry
  | ResolvedUserInputLedgerEntry;

export type ClaudeRequestLedgerEntry =
  | PendingApprovalLedgerEntry
  | ResolvedApprovalLedgerEntry
  | PendingUserInputLedgerEntry
  | ResolvingClaudeRequestLedgerEntry
  | ResolvedUserInputLedgerEntry;

export type ClaudeRequestLedger = Map<ApprovalRequestId, ClaudeRequestLedgerEntry>;

export function trimRequestLedger(ledger: ClaudeRequestLedger): void {
  while (ledger.size > REQUEST_LEDGER_LIMIT) {
    let oldestResolved: ApprovalRequestId | undefined;
    for (const [requestId, entry] of ledger) {
      if (entry.state === "resolved") {
        oldestResolved = requestId;
        break;
      }
    }
    const oldest = oldestResolved ?? ledger.keys().next().value;
    if (oldest === undefined) return;
    ledger.delete(oldest);
  }
}

export function rehydrateRequestLedger(ledger: ClaudeRequestLedger): void {
  for (const [requestId, entry] of ledger) {
    if (entry.requestId !== requestId) {
      ledger.delete(requestId);
    }
  }
  trimRequestLedger(ledger);
}
