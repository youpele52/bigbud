import { Effect, Schema } from "effect";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import {
  CODEX_COMPACTION_COMPLETED,
  CodexCompactionConfirmation,
} from "../Services/ProviderCompaction.ts";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { makeThreadOperations } from "./ProviderService.threadOperations.ts";
import { toValidationError } from "./ProviderServiceHelpers.ts";

/** Completion is exposed only after the exact manual proof has survived a durable owner CAS. */
export function makeCompactionDelivery(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
  threadOperation: ReturnType<typeof makeThreadOperations>,
  publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
) {
  return (event: ProviderRuntimeEvent) => {
    if (event.provider !== "codex" || event.raw?.method !== CODEX_COMPACTION_COMPLETED)
      return publish(event);
    return threadOperation(
      event.threadId,
      Effect.gen(function* () {
        const raw = event.raw?.payload;
        const proof = yield* Schema.decodeUnknownEffect(CodexCompactionConfirmation)({
          ...(raw && typeof raw === "object" ? raw : {}),
          threadId: event.threadId,
          sessionEpoch: event.sessionEpoch,
        });
        if (!directory.recordCodexCompaction)
          return yield* toValidationError(
            "compaction",
            "Durable compaction proof storage is unavailable.",
          );
        const adapter = yield* registry.getByProvider("codex");
        const live = yield* adapter.confirmCompaction?.(proof, false) ?? Effect.succeed(false);
        if (!live) return;
        yield* directory.recordCodexCompaction(proof);
        const acknowledged = yield* (
          adapter.confirmCompaction?.(proof, true) ?? Effect.succeed(false)
        );
        if (acknowledged) yield* publish(event);
      }),
      true,
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("manual compaction completion was not acknowledged", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );
  };
}
