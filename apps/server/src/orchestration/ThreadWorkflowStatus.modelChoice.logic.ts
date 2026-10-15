import type {
  ModelChoiceOutcome,
  ModelChoiceResolvedBy,
  ModelChoiceUnusableReason,
  RequestedModelSelection,
} from "@bigbud/contracts/orchestration/orchestration.delegationModelChoice";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import type { DelegatedModelChoiceRecord } from "@bigbud/shared/delegatedModelChoice";

/** The `get_thread_status` view of a delegated model choice: requested vs used. */
export interface ThreadModelChoiceStatus {
  readonly status: "pending" | "resolved";
  readonly requested: RequestedModelSelection | null;
  /** The model the tributary runs with; while pending, the fallback it uses without a pick. */
  readonly used: ModelSelection;
  readonly reason: ModelChoiceUnusableReason | null;
  readonly outcome: ModelChoiceOutcome | null;
  readonly resolvedBy: ModelChoiceResolvedBy | null;
  readonly deadlineAt?: string;
  readonly cancelled?: true;
}

export function toThreadModelChoiceStatus(
  record: DelegatedModelChoiceRecord,
): ThreadModelChoiceStatus {
  if (record.status === "pending") {
    return {
      status: "pending",
      requested: record.requested,
      used: record.fallback,
      reason: record.reason,
      outcome: null,
      resolvedBy: null,
      deadlineAt: record.deadlineAt,
    };
  }
  return {
    status: "resolved",
    requested: record.requested,
    used: record.used,
    reason: record.reason,
    outcome: record.outcome,
    resolvedBy: record.resolvedBy,
    ...(record.cancelled ? { cancelled: true as const } : {}),
  };
}
