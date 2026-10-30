import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option, Semaphore } from "effect";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { hasCodexRewindMarker } from "../Services/ProviderRewind.ts";
import { hasPendingInspectionTerminal } from "../Services/ProviderInspectionTerminal.ts";
import { toValidationError } from "./ProviderServiceHelpers.ts";

/** One admission lease; nested routing/recovery uses its caller's lease, never reacquires it. */
export function makeThreadOperations(directory: ProviderSessionDirectoryShape) {
  const leases = new Map<ThreadId, { readonly permit: Semaphore.Semaphore; users: number }>();
  return <A, E, R>(threadId: ThreadId, operation: Effect.Effect<A, E, R>, allowBlocked = false) =>
    Effect.suspend(() => {
      let entry = leases.get(threadId);
      if (!entry) {
        entry = { permit: Semaphore.makeUnsafe(1), users: 0 };
        leases.set(threadId, entry);
      }
      entry.users++;
      const lease = entry;
      return lease.permit
        .withPermits(1)(
          Effect.gen(function* () {
            const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
            if (
              !allowBlocked &&
              (hasCodexRewindMarker(binding?.runtimePayload) ||
                hasPendingInspectionTerminal(binding?.runtimePayload))
            )
              return yield* toValidationError(
                "ProviderService.threadOperation",
                "Codex rewind or terminal delivery is incomplete. New work and session restart are blocked; no native work was retried.",
              );
            return yield* operation;
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (--lease.users === 0) leases.delete(threadId);
            }),
          ),
        );
    });
}
