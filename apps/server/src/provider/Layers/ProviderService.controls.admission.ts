import { Effect } from "effect";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { makeThreadOperations } from "./ProviderService.threadOperations.ts";
import { toValidationError } from "./ProviderServiceHelpers.ts";

/** Reject overlapping controls immediately instead of queuing duplicate native mutations. */
export function coordinateProviderControls(
  controls: NonNullable<ProviderServiceShape["providerControls"]>,
  threadOperation: ReturnType<typeof makeThreadOperations>,
): NonNullable<ProviderServiceShape["providerControls"]> {
  const pending = new Set<ThreadId>();
  return (input) =>
    Effect.suspend(() => {
      if (pending.has(input.threadId))
        return Effect.fail(
          toValidationError(
            "providerControls",
            "A maintenance request is already in progress. It was not queued or retried.",
          ),
        );
      pending.add(input.threadId);
      return threadOperation(input.threadId, controls(input), true).pipe(
        Effect.ensuring(Effect.sync(() => pending.delete(input.threadId))),
      );
    });
}
