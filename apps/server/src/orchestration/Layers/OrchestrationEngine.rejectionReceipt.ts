import type { CommandId, ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Option } from "effect";

import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandOutcomePersistenceError } from "../Errors.ts";

function unknownOutcomeError(commandId: CommandId, cause: unknown) {
  return new OrchestrationCommandOutcomePersistenceError({
    commandId,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export function persistRejectedCommandReceipt(input: {
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
  readonly commandId: CommandId;
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
  readonly resultSequence: number;
  readonly rejectionReason: "thread_already_exists" | "other";
  readonly error: string;
  readonly payloadDigestVersion: string;
  readonly payloadDigest: string;
}) {
  return Effect.gen(function* () {
    yield* input.receipts.upsert({
      commandId: input.commandId,
      aggregateKind: input.aggregateKind,
      aggregateId: input.aggregateId,
      acceptedAt: new Date().toISOString(),
      resultSequence: input.resultSequence,
      status: "rejected",
      rejectionReason: input.rejectionReason,
      error: input.error,
      payloadDigestVersion: input.payloadDigestVersion,
      payloadDigest: input.payloadDigest,
    });
    const persisted = yield* input.receipts.getByCommandId({ commandId: input.commandId });
    if (Option.isNone(persisted)) {
      return yield* unknownOutcomeError(
        input.commandId,
        new Error("Rejected receipt was not durable."),
      );
    }
    return persisted.value.status === "accepted"
      ? ({ status: "accepted" as const, sequence: persisted.value.resultSequence } as const)
      : ({ status: "rejected" as const } as const);
  }).pipe(Effect.mapError((cause) => unknownOutcomeError(input.commandId, cause)));
}
