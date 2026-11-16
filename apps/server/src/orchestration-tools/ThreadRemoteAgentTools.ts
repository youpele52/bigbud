import { Data, Effect } from "effect";

import type {
  RemoteAgentControlRequest,
  RemoteAgentControlResponse,
} from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import type { RemoteAgentToolInput } from "./remoteAgentTools.shared.ts";

class RemoteAgentToolError extends Data.TaggedError("RemoteAgentToolError")<{
  readonly message: string;
}> {}

/**
 * Bounded in-call follow so a quick install returns its outcome directly. It stays well under
 * the shortest provider tool-call limit (OpenCode bridges abort at 10 s), so a long install still
 * hands the agent its operation ID to follow instead of erroring and inviting a duplicate install.
 */
export const REMOTE_AGENT_TOOL_FOLLOW_MS = 5_000;

function toolRequest(input: RemoteAgentToolInput): RemoteAgentControlRequest | string {
  const args =
    input.arguments && typeof input.arguments === "object"
      ? (input.arguments as Record<string, unknown>)
      : {};
  const target = typeof args.target === "string" ? args.target : "";
  if (input.tool === "remote_agent_install" && typeof args.operationId === "string") {
    return {
      method: "operation",
      operationId: args.operationId,
      waitMs: REMOTE_AGENT_TOOL_FOLLOW_MS,
    };
  }
  if (!target) return "target is required.";
  if (input.tool === "remote_agent_status") return { method: "status", target };
  // Agents never grant consent; unapproved hosts return consent-required for the user.
  return { method: "install", target, replace: args.replace === true, consent: false };
}

function toolResult(response: RemoteAgentControlResponse): Record<string, unknown> {
  if (!response.ok) return { ok: false, error: response.error };
  const result = response.result as Record<string, unknown>;
  if (result.status === "consent-required") {
    return {
      ...result,
      guidance:
        "Ask the user to approve this host: add it as a remote project in bigbud, or have them run `bigbud remote-agent install <target> --yes` themselves.",
    };
  }
  return result;
}

/** Thread tool entry point; per-thread authentication happens before dispatch. */
export function makeThreadRemoteAgentTool(
  handle: (request: RemoteAgentControlRequest) => Promise<RemoteAgentControlResponse>,
) {
  return (input: RemoteAgentToolInput) =>
    Effect.tryPromise({
      try: async () => {
        const request = toolRequest(input);
        if (typeof request === "string") return { ok: false, error: { message: request } };
        const response = await handle(request);
        if (
          request.method === "install" &&
          response.ok &&
          typeof (response.result as { operationId?: unknown }).operationId === "string"
        ) {
          const operationId = (response.result as { operationId: string }).operationId;
          return toolResult(
            await handle({ method: "operation", operationId, waitMs: REMOTE_AGENT_TOOL_FOLLOW_MS }),
          );
        }
        return toolResult(response);
      },
      catch: (cause) =>
        new RemoteAgentToolError({
          message: cause instanceof Error ? cause.message : "Remote agent tool failed.",
        }),
    });
}

let registeredHandler:
  | ((request: RemoteAgentControlRequest) => Promise<RemoteAgentControlResponse>)
  | null = null;

/** Registered by the remote-agent control layer, which sees the live remote-agent services. */
export function setThreadRemoteAgentToolHandler(
  handle: ((request: RemoteAgentControlRequest) => Promise<RemoteAgentControlResponse>) | null,
): void {
  registeredHandler = handle;
}

/** Dispatcher entry: typed unavailable until a backend with remote-agent services registers. */
export const remoteAgentToolViaOrchestration = (input: RemoteAgentToolInput) =>
  registeredHandler
    ? makeThreadRemoteAgentTool(registeredHandler)(input)
    : Effect.succeed<Record<string, unknown>>({
        ok: false,
        error: {
          code: "unavailable",
          message: "Remote agent tools are unavailable on this backend.",
        },
      });
