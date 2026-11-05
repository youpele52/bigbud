import { randomUUID } from "node:crypto";
import { EventId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { ProviderControlsInput } from "@bigbud/contracts/server/providerControls";
import { Effect, Option } from "effect";
import type { ProviderAdapterRegistryShape } from "../Services/ProviderAdapterRegistry.ts";
import type { ProviderSessionDirectoryShape } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { hasCodexRewindMarker } from "../Services/ProviderRewind.ts";
import { hasPendingInspectionTerminal } from "../Services/ProviderInspectionTerminal.ts";
import {
  decodeInputOrValidationError,
  readPersistedSessionEpoch,
  toValidationError,
} from "./ProviderServiceHelpers.ts";
import { unavailableProviderControls } from "../providerControls.ts";
import { readCodexCompactionProofs } from "../Services/ProviderCompaction.ts";

/** No recovery routing: maintenance may operate only on an already-owned native process. */
export function makeProviderControls(
  registry: ProviderAdapterRegistryShape,
  directory: ProviderSessionDirectoryShape,
  publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
): NonNullable<ProviderServiceShape["providerControls"]> {
  return Effect.fn("providerControls")(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "providerControls",
      schema: ProviderControlsInput,
      payload: rawInput,
    });
    const disabled = (reason: string) => unavailableProviderControls(input, reason);
    const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
    if (!binding || binding.provider !== "codex")
      return disabled("Native maintenance is unavailable for this session/provider.");
    const adapter = yield* registry.getByProvider(binding.provider);
    if (!adapter.controls) return disabled("This adapter does not support native maintenance.");
    const owns = Effect.gen(function* () {
      const current = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
      const session = (yield* adapter.listSessions()).find(
        (entry) => entry.threadId === input.threadId,
      );
      return (
        !!current &&
        !!session &&
        current.provider === binding.provider &&
        session.provider === binding.provider &&
        session.status !== "closed" &&
        session.sessionEpoch === input.sessionEpoch &&
        readPersistedSessionEpoch(current.runtimePayload) === input.sessionEpoch &&
        !hasCodexRewindMarker(current.runtimePayload) &&
        !hasPendingInspectionTerminal(current.runtimePayload) &&
        JSON.stringify(current.resumeCursor) === JSON.stringify(binding.resumeCursor) &&
        JSON.stringify(session.resumeCursor) === JSON.stringify(binding.resumeCursor) &&
        (session.providerRuntimeExecutionTargetId ?? session.executionTargetId ?? "local") ===
          (binding.providerRuntimeExecutionTargetId ?? binding.executionTargetId ?? "local") &&
        (session.workspaceExecutionTargetId ?? session.executionTargetId ?? "local") ===
          (binding.workspaceExecutionTargetId ?? binding.executionTargetId ?? "local")
      );
    });
    if (!(yield* owns))
      return disabled(
        "Requires the current live session epoch with no incomplete rewind or terminal publication.",
      );
    const canPersistCompaction =
      !!directory.recordCodexCompaction &&
      !!adapter.confirmCompaction &&
      readCodexCompactionProofs(binding.runtimePayload, "") !== null;
    let snapshot;
    if (input.action === "refresh-mcp") {
      snapshot = yield* adapter.controls({ ...input, action: "status" });
      if (snapshot.mcpStatus.available && adapter.mcp)
        snapshot = { ...snapshot, servers: yield* adapter.mcp.refresh(input.threadId) };
    } else if (input.action === "reload-mcp") {
      if (!adapter.mcp?.reloadAll) return disabled("Reload all MCP servers is unavailable.");
      snapshot = yield* adapter.mcp.reloadAll(input.threadId, input.sessionEpoch);
    } else
      snapshot = yield* adapter.controls(
        input.action === "compact" && !canPersistCompaction
          ? { ...input, action: "status" }
          : input,
      );
    if (!canPersistCompaction)
      snapshot = {
        ...snapshot,
        compact: {
          available: false,
          reason: "Durable manual compaction proof storage is unavailable or invalid.",
        },
      };
    if (!(yield* owns))
      return yield* toValidationError(
        "providerControls",
        "Session changed during maintenance; result discarded. No automatic retry.",
      );
    if (snapshot.servers)
      yield* publish({
        eventId: EventId.makeUnsafe(randomUUID()),
        type: "mcp.status.updated",
        provider: "codex",
        threadId: input.threadId,
        sessionEpoch: input.sessionEpoch,
        createdAt: new Date().toISOString(),
        payload: { status: snapshot.servers },
      });
    return snapshot;
  });
}
