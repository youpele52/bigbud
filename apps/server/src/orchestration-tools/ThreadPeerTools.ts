import { Effect } from "effect";

import type { PeerDispatchServiceShape, PeerToolResult } from "./peerDispatch.service.ts";
import type { PeerToolInput } from "./peerTools.shared.ts";

/**
 * Thread tool entry for P8 peer delegation (WP-8E). Per-thread authentication happens before
 * dispatch; the coordinator layer registers the dispatcher in remote mode. Until then, and while
 * no pairing has an active grant, `delegate_to_host` is a typed unavailable result.
 */
let registered: PeerDispatchServiceShape | null = null;

export function setThreadPeerToolHandler(service: PeerDispatchServiceShape | null): void {
  registered = service;
}

export const PEER_TOOL_UNAVAILABLE: PeerToolResult = {
  ok: false,
  unavailable: true,
  error: {
    code: "grant-missing",
    message: "No worker host is paired with this backend. Ask the user to pair a host in Settings.",
  },
};

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 ? value.slice(0, max) : undefined;

export function runPeerTool(
  service: PeerDispatchServiceShape | null,
  input: PeerToolInput,
): Effect.Effect<PeerToolResult, Error> {
  if (!service) return Effect.succeed(PEER_TOOL_UNAVAILABLE);
  const args =
    input.arguments && typeof input.arguments === "object"
      ? (input.arguments as Record<string, unknown>)
      : {};
  const callerThreadId = input.callerThreadId;
  if (input.tool === "delegate_to_host") {
    const task = text(args.task, 32_000);
    if (!task) return Effect.succeed({ ok: false, error: { message: "task is required." } });
    if (!input.invocationId.trim())
      return Effect.succeed({ ok: false, error: { message: "A tool invocation id is required." } });
    return service.delegate({
      callerThreadId,
      invocationId: input.invocationId,
      task,
      title: text(args.title, 200),
      host: text(args.host, 128),
      model: text(args.model, 256),
    });
  }
  const dispatchId = text(args.dispatchId, 64);
  if (!dispatchId)
    return Effect.succeed({ ok: false, error: { message: "dispatchId is required." } });
  return input.tool === "peer_dispatch_status"
    ? service.status({ callerThreadId, dispatchId })
    : service.cancel({ callerThreadId, dispatchId });
}

/** Dispatcher entry: typed unavailable until a coordinator backend registers. */
export const peerToolViaOrchestration = (input: PeerToolInput) => runPeerTool(registered, input);
