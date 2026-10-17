import type { SessionMessageAssistant } from "@opencode/client";
import { EventId, RuntimeItemId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";

/** A completed timestamp alone does not settle an assistant with unfinished tools. */
export function isV2AssistantSettled(message: SessionMessageAssistant): boolean {
  return (
    Number.isFinite(message.time.completed) &&
    message.content.every(
      (part) =>
        part.type !== "tool" || part.state.status === "completed" || part.state.status === "error",
    )
  );
}

/** Map only a proven correlated, completed projection; never infer a turn from read time. */
export function authoritativeAssistantRepair(input: {
  readonly admission: ProviderTurnAdmission;
  readonly message: SessionMessageAssistant;
  readonly nativeSessionId: string;
  readonly location: string;
  readonly sessionEpoch: number;
  readonly isCurrent: boolean;
  readonly correlationProven: boolean;
}): ProviderRuntimeEvent | undefined {
  const { admission, message } = input;
  if (
    !input.isCurrent ||
    !input.correlationProven ||
    admission.binding.provider !== "opencodeV2" ||
    (admission.state !== "accepted" && admission.state !== "terminal") ||
    input.nativeSessionId !== admission.binding.nativeSessionId ||
    input.location !== admission.binding.location ||
    !Number.isInteger(input.sessionEpoch) ||
    input.sessionEpoch < 0 ||
    !isV2AssistantSettled(message) ||
    message.error ||
    message.retry ||
    message.finish === "error" ||
    message.finish === "unknown"
  )
    return undefined;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (!text || text.length > 2_000_000) return undefined;
  return {
    type: "item.completed",
    provider: "opencodeV2",
    threadId: admission.binding.threadId,
    turnId: admission.turnId,
    sessionEpoch: input.sessionEpoch,
    itemId: RuntimeItemId.makeUnsafe(message.id),
    eventId: EventId.makeUnsafe(`opencode-v2-final:${admission.turnId}:${message.id}`),
    createdAt: new Date(message.time.completed!).toISOString(),
    payload: { itemType: "assistant_message", status: "completed", detail: text },
  };
}
