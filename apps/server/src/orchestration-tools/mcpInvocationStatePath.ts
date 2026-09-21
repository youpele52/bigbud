import { createHash } from "node:crypto";
import path from "node:path";

const MCP_INVOCATION_STATE_DIRECTORY = "mcp-invocation-state";

export type McpInvocationStateNamespace = "orchestration" | "remote-workspace";

function invocationScopeId(threadId: string, providerSessionId: string): string {
  return createHash("sha256").update(`${threadId}\u0000${providerSessionId}`).digest("hex");
}

/**
 * Returns a stable, server-owned path for one provider session and MCP surface.
 * The path intentionally contains a digest rather than thread/session data.
 */
export function resolveMcpInvocationStatePath(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly namespace: McpInvocationStateNamespace;
}): string {
  return path.join(
    input.stateDir,
    MCP_INVOCATION_STATE_DIRECTORY,
    `${invocationScopeId(input.threadId, input.providerSessionId)}.${input.namespace}`,
  );
}

/** Derives a separate durable directory for a related MCP surface. */
export function deriveMcpInvocationStatePath(
  basePath: string,
  namespace: McpInvocationStateNamespace,
): string {
  const knownNamespace = /\.(?:orchestration|remote-workspace)(?:\.json)?$/;
  const stem = knownNamespace.test(basePath) ? basePath.replace(knownNamespace, "") : basePath;
  return `${stem}.${namespace}`;
}
