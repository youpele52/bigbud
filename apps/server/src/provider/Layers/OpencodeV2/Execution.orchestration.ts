import { createHash } from "node:crypto";
import { Schema } from "effect";
import { ThreadToolRequest } from "../../../ws/http.threadTools.schema.ts";
import {
  THREAD_ORCHESTRATION_API_PATH,
  type ThreadOrchestrationHttpConfig,
} from "../../../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { createThreadOrchestrationBridge } from "../../../orchestration-tools/orchestrationMcpBridge.ts";
import { beginThreadToolDispatch } from "../../../orchestration-tools/threadToolInvocationFlights.ts";

export const V2_ORCHESTRATION_ACTIONS = [
  "rename",
  "archive",
  "get_status",
  "list_pinned",
  "pin",
  "unpin",
  "browser",
  "computer_use",
  "create_thread",
  "send_thread_message",
  "list_threads",
  "search_capabilities",
  "read_capability_guide",
  "workspace",
  "get_system_resources",
] as const;

/** Canonical invocation id for a serialized invocation identity (the durable receipt key). */
export const v2OrchestrationInvocationId = (receiptKey: string) =>
  `v2-tool:${createHash("sha256").update(receiptKey).digest("hex")}`;

/** Existing canonical HTTP tool dispatch is the bigbud-level route, not a native fork/subagent API. */
export function prepareV2OrchestrationRequest(body: unknown, identity: readonly string[]) {
  const request = Schema.decodeUnknownSync(ThreadToolRequest)(body);
  if (
    !V2_ORCHESTRATION_ACTIONS.some((action) => action === request.action) ||
    request.workspacePath !== undefined
  )
    throw new Error("V2 orchestration action is not supported.");
  const invocationId = v2OrchestrationInvocationId(JSON.stringify(identity));
  const sourceMessageId = `mcp-source:${createHash("sha256").update(invocationId).digest("hex")}`;
  const prepared = { ...request, invocationId, sourceMessageId };
  if (Buffer.byteLength(JSON.stringify(prepared)) > 32768)
    throw new Error("V2 canonical tool request exceeds bound.");
  return prepared;
}

export async function callV2Orchestration(
  config: ThreadOrchestrationHttpConfig,
  body: unknown,
  identity: readonly string[],
  beforeRequest: () => Promise<() => void>,
  signal?: AbortSignal,
) {
  const request = prepareV2OrchestrationRequest(body, identity);
  return callV2PreparedOrchestration(config, request, beforeRequest, signal);
}

/** Dispatch an already captured/validated body without rerunning mutable argument preparation. */
export async function callV2PreparedOrchestration(
  config: ThreadOrchestrationHttpConfig,
  request: ReturnType<typeof prepareV2OrchestrationRequest>,
  beforeRequest: () => Promise<() => void>,
  signal?: AbortSignal,
) {
  if (config.host !== "127.0.0.1" || !Number.isSafeInteger(config.port) || config.port < 1)
    throw new Error("V2 orchestration endpoint must be owned loopback.");
  const validate = await beforeRequest();
  validate();
  signal?.throwIfAborted();
  // This server's own route enters the same invocation; an abandoned dispatch is fenced there.
  const settle = beginThreadToolDispatch(request.invocationId);
  try {
    return await fetchV2Orchestration(config, request, signal);
  } finally {
    settle();
  }
}

async function fetchV2Orchestration(
  config: ThreadOrchestrationHttpConfig,
  request: ReturnType<typeof prepareV2OrchestrationRequest>,
  signal?: AbortSignal,
) {
  const response = await fetch(
    `http://${config.host}:${config.port}${THREAD_ORCHESTRATION_API_PATH}`,
    {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "x-bigbud-thread-tool-token": config.token },
      body: JSON.stringify(request),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    },
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("V2 orchestration response unavailable.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 131072) throw new Error("V2 orchestration response exceeds bound.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (!response.ok) throw new Error(`V2 canonical tool refused (${response.status}).`);
  JSON.parse(text);
  return { content: text };
}

export async function prepareV2Orchestration(stateDir: string, threadId: string, port: number) {
  return createThreadOrchestrationBridge({
    stateDir,
    threadId,
    host: "127.0.0.1",
    port,
    providerSessionId: `opencodeV2:${threadId}`,
  });
}
