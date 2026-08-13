import { Effect, Option } from "effect";

import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";

export function makeInspectActiveTurn(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
): ProviderServiceShape["inspectActiveTurn"] {
  return Effect.fn("inspectActiveTurn")(function* (input) {
    const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
    if (!binding) {
      return {
        status: "missing",
        observedAt: new Date().toISOString(),
        errorEvidence: {
          source: "provider-session-directory",
          detail: "No provider session binding exists for this thread.",
        },
      };
    }
    const adapter = yield* registry.getByProvider(binding.provider);
    if (!(yield* adapter.hasSession(input.threadId))) {
      return {
        status: "missing",
        observedAt: new Date().toISOString(),
        errorEvidence: {
          source: `${binding.provider}.hasSession`,
          detail: "The provider no longer owns an active session for this thread.",
        },
      };
    }
    return yield* adapter.inspectActiveTurn(input.threadId, input.turnId);
  });
}
