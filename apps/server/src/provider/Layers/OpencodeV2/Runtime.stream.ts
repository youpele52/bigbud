import type { OpenCodeEvent } from "@opencode/client";
import { RuntimeItemId } from "@bigbud/contracts/core/baseSchemas";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { correlatedProjection, readV2Messages, runtimeEventBase } from "./Runtime.projection.ts";

/** A delivery's original signal/owner generation survives queueing and hydration awaits. */
export async function consumeV2RuntimeEvent(
  runtime: OpencodeV2Runtime,
  session: V2RuntimeSession,
  event: OpenCodeEvent,
  validate: () => void,
) {
  validate();
  if (session.stopped || !session.row || session.row.state !== "accepted") return;
  if (event.type !== "session.text.delta" && event.type !== "session.reasoning.delta") {
    await runtime.reconcile(session);
    validate();
    return;
  }
  if (!session.messages.has(event.data.assistantMessageID)) {
    const messages = await readV2Messages(session);
    validate();
    const projection = correlatedProjection(session, messages);
    if (!projection) return;
    for (const message of projection.assistants) session.messages.set(message.id, message);
  }
  const message = session.messages.get(event.data.assistantMessageID);
  if (
    !message ||
    message.type !== "assistant" ||
    message.time.completed !== undefined ||
    session.stopped
  )
    return;
  await runtime.emit(
    session,
    {
      ...runtimeEventBase(session, event.id, event.created),
      itemId: RuntimeItemId.makeUnsafe(
        event.type === "session.text.delta"
          ? event.data.assistantMessageID
          : `${event.data.assistantMessageID}:reasoning`,
      ),
      type: "content.delta",
      payload: {
        streamKind: event.type === "session.text.delta" ? "assistant_text" : "reasoning_text",
        delta: event.data.delta,
        contentIndex: event.data.ordinal,
      },
    },
    validate,
  );
}
