import type { CommandId, GetCommandOutcomeResult } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { OrchestrationCommandReceiptRepositoryError } from "../../persistence/Errors.ts";

export function makeCommandOutcomeQuery(input: {
  readonly serverEpoch: string;
  readonly canonicalRevision: () => number;
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
}) {
  return (
    commandId: CommandId,
  ): Effect.Effect<GetCommandOutcomeResult, OrchestrationCommandReceiptRepositoryError> =>
    input.receipts.getByCommandId({ commandId }).pipe(
      Effect.map((receipt) => {
        const canonicalRevision = input.canonicalRevision();
        if (Option.isNone(receipt)) {
          return {
            commandId,
            status: "unknown" as const,
            serverEpoch: input.serverEpoch,
            canonicalRevision,
          };
        }
        const common = {
          commandId,
          aggregateKind: receipt.value.aggregateKind,
          aggregateId: receipt.value.aggregateId,
          resultSequence: receipt.value.resultSequence,
          serverEpoch: input.serverEpoch,
          canonicalRevision: Math.max(canonicalRevision, receipt.value.resultSequence),
        };
        if (receipt.value.status === "accepted") {
          return Object.assign({}, common, {
            status: "accepted" as const,
            acceptedAt: receipt.value.acceptedAt,
          });
        }
        return Object.assign({}, common, {
          status: "rejected" as const,
          rejectedAt: receipt.value.acceptedAt,
          reason: receipt.value.rejectionReason ?? "other",
        });
      }),
    );
}
