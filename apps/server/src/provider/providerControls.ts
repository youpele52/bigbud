import type {
  ProviderControlsInput,
  ProviderControlsSnapshot,
} from "@bigbud/contracts/server/providerControls";

/** Shared disabled snapshot, including explicitly unsupported native operations. */
export function unavailableProviderControls(
  input: Pick<ProviderControlsInput, "threadId" | "sessionEpoch">,
  reason: string,
): ProviderControlsSnapshot {
  const unavailable = { available: false, reason };
  return {
    threadId: input.threadId,
    sessionEpoch: input.sessionEpoch,
    compact: unavailable,
    mcpStatus: unavailable,
    mcpReload: unavailable,
    mcpTargeted: {
      available: false,
      reason: "Targeted reconnect, toggle and replace are unavailable. Use Reload all MCP servers.",
    },
    compactState: "idle",
  };
}
