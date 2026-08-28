import { Cause, Deferred, Effect, Exit } from "effect";

import type { OrchestrationCommandReceiptRepositoryShape } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  commandToAggregateRef,
  type CommandEnvelope,
} from "./OrchestrationEngine.commandProcessing.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { persistRejectedCommandReceipt } from "./OrchestrationEngine.rejectionReceipt.ts";

export const settlePreflightFailure = (input: {
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
  readonly readModelSequence: number;
  readonly envelope: CommandEnvelope;
  readonly error: OrchestrationCommandInvariantError;
}) =>
  Effect.gen(function* () {
    const aggregate = commandToAggregateRef(input.envelope.command);
    const persisted = yield* Effect.exit(
      persistRejectedCommandReceipt({
        receipts: input.receipts,
        commandId: input.envelope.command.commandId,
        aggregateKind: aggregate.aggregateKind,
        aggregateId: aggregate.aggregateId,
        resultSequence: input.readModelSequence,
        rejectionReason:
          input.error.code === "thread_already_exists" ? "thread_already_exists" : "other",
        error: input.error.message,
        payloadDigestVersion: input.envelope.payloadDigest.version,
        payloadDigest: input.envelope.payloadDigest.digest,
      }),
    );
    if (Exit.isFailure(persisted)) {
      yield* Deferred.fail(
        input.envelope.result,
        Cause.squash(persisted.cause) as OrchestrationDispatchError,
      );
      return;
    }
    if (persisted.value.status === "accepted") {
      yield* Deferred.succeed(input.envelope.result, {
        sequence: persisted.value.sequence,
      });
      return;
    }
    yield* Deferred.fail(input.envelope.result, input.error);
  });
