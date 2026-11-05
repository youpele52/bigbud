import type { MuseBridgeHandle } from "./Adapter.types.ts";

/**
 * Session MCP injection shaping for Muse. The canonical bridge itself is
 * created by orchestration-tools/museThreadOrchestrationTools.ts; this
 * module only converts its handle to the `session/start`/`session/resume`
 * `config.mcpServers` member. Bridge tokens and ephemeral paths stay inside
 * the bridge handle and are never persisted in cursors or bindings.
 */
export function buildMuseSessionConfig(bridge: MuseBridgeHandle | undefined): {
  readonly config?: { readonly mcpServers: Record<string, unknown> };
} {
  return bridge ? { config: { mcpServers: bridge.config } } : {};
}
