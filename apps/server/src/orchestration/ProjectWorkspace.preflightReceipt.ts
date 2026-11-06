import type { OrchestrationCommand } from "@bigbud/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { calculateCommandPayloadDigest } from "./commandDigest.ts";
import { persistRejectedCommandReceipt } from "./Layers/OrchestrationEngine.rejectionReceipt.ts";

export const WORKSPACE_PREFLIGHT_DETAIL_PREFIX = "Workspace preflight: ";

/** A definitive refusal is recoverable as a receipt only BEFORE a durable native operation.
 * Never convert a fenced partial transition into rejection, even if its error is an invariant.
 */
export function recordWorkspacePreflightRefusal(input: {
  sql: SqlClient.SqlClient;
  engine: OrchestrationEngineShape;
  receipts?: OrchestrationCommandReceiptRepositoryShape;
  command: OrchestrationCommand;
  error: OrchestrationCommandInvariantError;
}) {
  const { sql, engine, receipts, command, error } = input;
  if (!receipts || !engine.withWorkspaceBarrier || command.type !== "project.reconfigure")
    return Effect.fail(error);
  return engine
    .withWorkspaceBarrier(
      sql.withTransaction(
        Effect.gen(function* () {
          const installed =
            yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_workspace_native_operations'`;
          const retained = installed.length
            ? yield* sql`SELECT 1 FROM project_workspace_native_operations WHERE command_id = ${command.commandId}`
            : [];
          if (retained.length) return { status: "retained" as const };
          const digest = calculateCommandPayloadDigest(command);
          const claim = yield* receipts.claimOrInspect({
            commandId: command.commandId,
            payloadDigest: digest.digest,
            payloadDigestVersion: digest.version,
            claimedAt: new Date().toISOString(),
          });
          if (claim.status === "existing")
            return claim.receipt.status === "accepted"
              ? { status: "accepted" as const, sequence: claim.receipt.resultSequence }
              : { status: "rejected" as const };
          if (claim.status === "conflict") return { status: "conflict" as const };
          return yield* persistRejectedCommandReceipt({
            receipts,
            commandId: command.commandId,
            aggregateKind: "project",
            aggregateId: command.projectId,
            resultSequence: (yield* engine.getReadModel()).snapshotSequence,
            rejectionReason: "other",
            error: `${WORKSPACE_PREFLIGHT_DETAIL_PREFIX}${error.detail}`,
            payloadDigest: digest.digest,
            payloadDigestVersion: digest.version,
          });
        }),
      ),
    )
    .pipe(
      Effect.flatMap((result) =>
        result.status === "accepted"
          ? Effect.succeed({ sequence: result.sequence })
          : Effect.fail(error),
      ),
    );
}
