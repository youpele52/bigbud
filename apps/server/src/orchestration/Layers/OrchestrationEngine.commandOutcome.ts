import type { CommandId, GetCommandOutcomeResult } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import type { OrchestrationCommandReceiptRepositoryError } from "../../persistence/Errors.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { readProjectWorkspaceStatus } from "../ProjectWorkspace.status.ts";
import { WORKSPACE_PREFLIGHT_DETAIL_PREFIX } from "../ProjectWorkspace.preflightReceipt.ts";

export function makeCommandOutcomeQuery(input: {
  readonly serverEpoch: string;
  readonly canonicalRevision: () => number;
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
  readonly workspaceSql?: SqlClient.SqlClient;
}) {
  return (
    commandId: CommandId,
  ): Effect.Effect<GetCommandOutcomeResult, OrchestrationCommandReceiptRepositoryError> =>
    input.receipts.getByCommandId({ commandId }).pipe(
      Effect.flatMap((receipt) =>
        Effect.gen(function* () {
          const canonicalRevision = input.canonicalRevision();
          if (Option.isNone(receipt)) {
            const workspaceTransition = input.workspaceSql
              ? yield* readProjectWorkspaceStatus(input.workspaceSql, commandId)
              : undefined;
            return {
              ...(workspaceTransition ? { workspaceTransition } : {}),
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
            ...(receipt.value.aggregateKind === "project" &&
            receipt.value.error?.startsWith(WORKSPACE_PREFLIGHT_DETAIL_PREFIX)
              ? { detail: receipt.value.error.slice(WORKSPACE_PREFLIGHT_DETAIL_PREFIX.length) }
              : {}),
          });
        }),
      ),
    );
}
