/**
 * P8 peer delegation tools (M6 WP-8E): delegate a task to a paired worker host, read a dispatch's
 * status and cancel it. Every provider surface renders these from the same specs. Without an
 * active pairing `delegate_to_host` returns a typed unavailable result (`grant-missing`).
 */
import { isBackgroundSessionThreadId } from "../provider/backgroundSessionThreads.ts";

export const PEER_TOOL_NAMES = [
  "delegate_to_host",
  "peer_dispatch_status",
  "peer_dispatch_cancel",
] as const;
export type PeerToolName = (typeof PEER_TOOL_NAMES)[number];

export function isPeerToolName(value: unknown): value is PeerToolName {
  return (PEER_TOOL_NAMES as ReadonlyArray<unknown>).includes(value);
}

export const DELEGATE_TO_HOST_TOOL_DESCRIPTION =
  "Delegate a self-contained task to another bigbud host the user paired with this backend (Settings > Peer hosts). The worker runs it in its own thread with its own repository copy; files are not shared. Returns a dispatchId; the bounded result is delivered into this thread when the worker finishes. Retrying the same call never starts a second task. Returns unavailable when no host is paired.";
export const PEER_DISPATCH_STATUS_TOOL_DESCRIPTION =
  "Read the state of a task delegated with delegate_to_host (pending, sent-uncertain, accepted, following, cancel-pending, completed, failed or cancelled) and its result once finished. Read-only.";
export const PEER_DISPATCH_CANCEL_TOOL_DESCRIPTION =
  "Request cancellation of a task delegated with delegate_to_host. The state shows cancel-pending until the worker confirms; if the task finished first its real outcome is kept.";

const DISPATCH_ID = { type: "string", pattern: "^[0-9a-f-]{36}$" };

export const PEER_TOOL_SPECS = [
  {
    name: "delegate_to_host",
    description: DELEGATE_TO_HOST_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: { type: "string", minLength: 1, maxLength: 32000 },
        title: { type: "string", maxLength: 200 },
        host: { type: "string", maxLength: 128 },
        model: { type: "string", maxLength: 256 },
      },
    },
  },
  {
    name: "peer_dispatch_status",
    description: PEER_DISPATCH_STATUS_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["dispatchId"],
      properties: { dispatchId: DISPATCH_ID },
    },
  },
  {
    name: "peer_dispatch_cancel",
    description: PEER_DISPATCH_CANCEL_TOOL_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["dispatchId"],
      properties: { dispatchId: DISPATCH_ID },
    },
  },
] as const;

export interface PeerToolInput {
  readonly callerThreadId: string;
  /** Stable per tool call; `delegate_to_host` derives its idempotency key from it. */
  readonly invocationId: string;
  readonly tool: PeerToolName;
  readonly arguments: unknown;
}

/**
 * The one rule for who sees the peer tools (O-2): user-driven threads only. Background sessions
 * (learning reviews) replay a transcript the user is not steering, so every provider surface
 * leaves the tools out of their list and the dispatcher refuses them.
 */
export function peerToolsOfferedTo(threadId: string): boolean {
  return !isBackgroundSessionThreadId(threadId);
}

export const PEER_TOOLS_NOT_OFFERED = {
  ok: false,
  unavailable: true,
  error: {
    code: "action-not-allowed",
    message: "Peer delegation is only available to user-driven threads.",
  },
} as const;
