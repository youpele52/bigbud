import type { ProviderCompactState } from "@bigbud/contracts/server/providerControls";
import type { CodexSessionContext, JsonRpcNotification } from "./codexAppServerManager.types.ts";
import { readObject, readString } from "./codexAppServerManager.protocol.ts";
import { readResumeThreadId } from "./codexAppServerManager.utils.ts";
import type {
  CodexCompactionConfirmation,
  CodexCompactionProof,
} from "../provider/Services/ProviderCompaction.ts";

export interface CodexCompactOperation {
  state: ProviderCompactState;
  deadline: number;
  dispatched?: boolean;
  itemCompleted?: boolean;
  terminalStatus?: "completed" | "failed";
  proofEmitted?: boolean;
  proofRecorded?: boolean;
  turnId?: string | undefined;
  itemId?: string | undefined;
}

/** Unknown is fenced until a matching native lifecycle settles it; never auto-resend. */
export function compactBlocksWork(context: CodexSessionContext): boolean {
  const compact = context.manualCompact;
  if (!compact?.dispatched) return false;
  if (
    (compact.state === "submitted" || compact.state === "working") &&
    Date.now() >= compact.deadline
  )
    compact.state = "unknown";
  return ["submitted", "working", "unknown"].includes(compact.state);
}

/** Pinned v2 ThreadItem contextCompaction item/started + item/completed, never the RPC ack. */
export function observeManualCompact(
  context: CodexSessionContext,
  notification: JsonRpcNotification,
) {
  const compact = context.manualCompact;
  if (!compact) return false;
  const params = readObject(notification.params);
  if (readString(params, "threadId") !== readResumeThreadId(context.session)) return false;
  const turnId = readString(params, "turnId") ?? readString(readObject(params, "turn"), "id");
  if (compactBlocksWork(context) && notification.method === "turn/started" && !compact.turnId)
    compact.turnId = turnId;
  const item = readObject(params, "item");
  if (readString(item, "type") === "contextCompaction" && turnId && compactBlocksWork(context)) {
    if (compact.turnId && compact.turnId !== turnId) return false;
    if (
      notification.method === "item/started" &&
      readString(item, "id") &&
      !compact.itemCompleted
    ) {
      compact.turnId = turnId;
      compact.itemId = readString(item, "id");
      compact.state = "working";
    }
    if (
      notification.method === "item/completed" &&
      compact.itemId &&
      compact.itemId === readString(item, "id") &&
      compact.turnId === turnId
    ) {
      compact.itemCompleted = true;
      compact.state =
        compact.terminalStatus === "completed"
          ? compact.proofRecorded
            ? "completed"
            : "working"
          : compact.terminalStatus === "failed"
            ? "failed"
            : "working";
      context.historyGeneration = (context.historyGeneration ?? 0) + 1;
    }
  }
  if (turnId && turnId === compact.turnId && notification.method === "turn/completed") {
    const status = readString(readObject(params, "turn"), "status");
    if (status === "failed" || status === "interrupted") {
      compact.terminalStatus = "failed";
      compact.state = "failed";
    } else if (status === "completed") {
      compact.terminalStatus = "completed";
      compact.state = compact.itemCompleted
        ? compact.proofRecorded
          ? "completed"
          : "working"
        : "unknown";
    } else compact.state = "unknown";
  }
  // Native maintenance turns have no ordinary user turn/checkpoint in the canonical transcript.
  return (
    !!turnId &&
    compact.turnId === turnId &&
    (notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      ((notification.method === "item/started" || notification.method === "item/completed") &&
        readString(item, "type") === "contextCompaction"))
  );
}

/** Emit proof once after both native lifecycles, while admission remains fenced until durable ack. */
export function takeCodexCompactionProof(
  context: CodexSessionContext,
): CodexCompactionProof | undefined {
  const compact = context.manualCompact;
  const nativeThreadId = readResumeThreadId(context.session);
  if (
    !compact?.dispatched ||
    !compact.itemCompleted ||
    compact.terminalStatus !== "completed" ||
    compact.proofEmitted ||
    !compact.turnId ||
    !compact.itemId ||
    !nativeThreadId
  )
    return;
  compact.proofEmitted = true;
  return { nativeThreadId, turnId: compact.turnId, itemId: compact.itemId };
}

/** Verify exact native proof; only persisted acknowledgment releases admission, never a fake terminal. */
export function confirmCodexCompaction(
  context: CodexSessionContext | undefined,
  input: CodexCompactionConfirmation,
  persisted = true,
): boolean {
  const compact = context?.manualCompact;
  if (
    !context ||
    context.stopping ||
    context.session.sessionEpoch !== input.sessionEpoch ||
    readResumeThreadId(context.session) !== input.nativeThreadId ||
    !compact?.dispatched ||
    !compact.itemCompleted ||
    compact.terminalStatus !== "completed" ||
    compact.turnId !== input.turnId ||
    compact.itemId !== input.itemId
  )
    return false;
  if (persisted) {
    compact.proofRecorded = true;
    compact.state = "completed";
  }
  return true;
}
