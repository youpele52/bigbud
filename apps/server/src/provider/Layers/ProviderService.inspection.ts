import { Effect, Option } from "effect";

import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import { readPersistedSessionEpoch } from "./ProviderServiceHelpers.ts";
import { hasCodexRewindMarker } from "../Services/ProviderRewind.ts";

const unavailable = () => ({
  status: "unavailable" as const,
  observedAt: new Date().toISOString(),
});

export function makeInspectActiveTurn(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
): ProviderServiceShape["inspectActiveTurn"] {
  return Effect.fn("inspectActiveTurn")(function* (input) {
    const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
    if (
      !binding ||
      hasCodexRewindMarker(binding.runtimePayload) ||
      (readPersistedSessionEpoch(binding.runtimePayload) ?? 0) !== input.sessionEpoch
    )
      return unavailable();
    const adapter = yield* registry.getByProvider(binding.provider);
    const owns = Effect.gen(function* () {
      const session = (yield* adapter.listSessions()).find(
        (entry) => entry.threadId === input.threadId,
      );
      const current = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      return (
        current !== undefined &&
        session !== undefined &&
        current.provider === binding.provider &&
        session.provider === binding.provider &&
        !hasCodexRewindMarker(current.runtimePayload) &&
        (readPersistedSessionEpoch(current.runtimePayload) ?? 0) === input.sessionEpoch &&
        (session.sessionEpoch ?? 0) === input.sessionEpoch &&
        (session.providerRuntimeExecutionTargetId ?? session.executionTargetId ?? "local") ===
          (binding.providerRuntimeExecutionTargetId ?? binding.executionTargetId ?? "local") &&
        (session.workspaceExecutionTargetId ?? session.executionTargetId ?? "local") ===
          (binding.workspaceExecutionTargetId ?? binding.executionTargetId ?? "local") &&
        session.status !== "closed" &&
        JSON.stringify(current.resumeCursor) === JSON.stringify(binding.resumeCursor) &&
        (binding.provider !== "codex" ||
          JSON.stringify(session.resumeCursor) === JSON.stringify(binding.resumeCursor))
      );
    });
    if (!(yield* adapter.hasSession(input.threadId)) || !(yield* owns)) return unavailable();
    const result = yield* adapter.inspectActiveTurn(input.threadId, input.turnId);
    return (yield* owns) ? result : unavailable();
  });
}

/** No native mutation; synchronize the live projection only after final items were durably ingested. */
export function makeConfirmInspectedTurn(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
): NonNullable<ProviderServiceShape["confirmInspectedTurn"]> {
  return (input) =>
    Effect.gen(function* () {
      const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      if (
        !binding ||
        binding.provider !== "codex" ||
        hasCodexRewindMarker(binding.runtimePayload) ||
        readPersistedSessionEpoch(binding.runtimePayload) !== input.sessionEpoch
      )
        return "rejected" as const;
      const adapter = yield* registry.getByProvider(binding.provider);
      const current = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      if (
        !current ||
        current.provider !== binding.provider ||
        hasCodexRewindMarker(current.runtimePayload) ||
        readPersistedSessionEpoch(current.runtimePayload) !== input.sessionEpoch ||
        JSON.stringify(current.resumeCursor) !== JSON.stringify(binding.resumeCursor)
      )
        return "rejected" as const;
      const confirmation = yield* (
        adapter.confirmInspectedTurn?.(
          input.threadId,
          input.turnId,
          input.sessionEpoch,
          input.status,
          input.publication,
        ) ?? Effect.succeed("rejected" as const)
      );
      const latest = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      return latest?.provider === binding.provider &&
        readPersistedSessionEpoch(latest.runtimePayload) === input.sessionEpoch &&
        !hasCodexRewindMarker(latest.runtimePayload) &&
        JSON.stringify(latest.resumeCursor) === JSON.stringify(binding.resumeCursor)
        ? confirmation
        : ("rejected" as const);
    });
}
