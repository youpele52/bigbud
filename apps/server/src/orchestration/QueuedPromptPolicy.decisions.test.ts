import { CommandId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import { evaluateQueuedPromptFlush } from "./QueuedPromptPolicy.logic.ts";
import {
  model,
  now,
  operation,
  prompt,
  thread,
  threadId,
} from "./QueuedPromptPolicy.test.helpers.ts";
import { makeQueuedPromptFlushCommand } from "./QueuedPromptFlush.logic.ts";
import { calculateCommandPayloadDigest } from "./commandDigest.ts";
import { makeReservedQueuedPromptFlushCommand } from "./QueuedPromptFlush.control.ts";

const ids = [prompt("one").id, prompt("two").id];
describe("explicit queue decisions and immutable attempts", () => {
  it.each([
    [{ session: null, queueHold: true }, "queue_held"],
    [{}, "queue_busy"],
    [{ session: null, archivedAt: now }, "queue_unavailable"],
    [{ pendingTurnControlOperation: operation() }, "queue_reserved"],
    [{ session: null, queuedPrompts: [] }, "queue_stale_selection"],
  ] as const)("reports the authoritative refusal %s", (overrides, reason) => {
    expect(evaluateQueuedPromptFlush({ thread: thread(overrides), messageIds: ids })).toMatchObject(
      { reason },
    );
  });

  it("distinguishes invalid ownership and production null intent", () => {
    expect(
      evaluateQueuedPromptFlush({
        thread: thread({ session: null }),
        messageIds: ids,
        controlOperationId: CommandId.makeUnsafe("wrong"),
      }),
    ).toMatchObject({ reason: "queue_invalid_owner" });
    expect(
      evaluateQueuedPromptFlush({
        thread: thread({ session: null, pendingInterruptFlushIntent: null }),
        messageIds: ids,
      }),
    ).toMatchObject({ status: "ready" });
  });

  it("fences redelivery under the same prompt ID", () => {
    expect(
      evaluateQueuedPromptFlush({
        thread: thread({ session: null }),
        messageIds: ids,
        promptVersions: ids.map((id) => ({ id, createdAt: now, alreadySent: true })),
      }),
    ).toMatchObject({ reason: "queue_stale_selection" });
  });

  it("reconstructs identical full payload/digest and separates logical message from attempts", () => {
    const readModel = model(thread({ session: null }));
    const first = makeQueuedPromptFlushCommand({ threadId, readModel, createdAt: now });
    const second = makeQueuedPromptFlushCommand({
      threadId,
      readModel,
      createdAt: "2026-10-28T12:00:00.000Z",
    });
    expect(second).toEqual(first);
    expect(calculateCommandPayloadDigest(second!)).toEqual(calculateCommandPayloadDigest(first!));
    const next = makeQueuedPromptFlushCommand({
      threadId,
      readModel: { ...readModel, snapshotSequence: 1 },
      createdAt: now,
    });
    expect(next?.commandId).not.toBe(first?.commandId);
    expect(next?.type === "thread.queued-prompt.flush" && next.messageId).toBe(
      first?.type === "thread.queued-prompt.flush" && first.messageId,
    );
  });

  it("reconstructs the same owned attempt for live and restart consumers", () => {
    const op = operation({
      strategy: "interrupt-continue",
      state: "provider-acknowledged",
      reservedPromptIds: ids,
    });
    const value = thread({
      session: null,
      pendingTurnControlOperation: { ...op, sessionEpoch: 0 },
    });
    const input = { thread: value, operation: value.pendingTurnControlOperation!, revision: 1 };
    expect(makeReservedQueuedPromptFlushCommand(input)).not.toBeNull();
    expect(makeReservedQueuedPromptFlushCommand({ ...input, revision: 2 })?.commandId).not.toBe(
      makeReservedQueuedPromptFlushCommand(input)?.commandId,
    );
    expect(
      makeReservedQueuedPromptFlushCommand({
        ...input,
        operation: { ...input.operation, operationId: CommandId.makeUnsafe("older-owner") },
      }),
    ).toBeNull();
    expect(makeReservedQueuedPromptFlushCommand(input)).toEqual(
      makeReservedQueuedPromptFlushCommand(input),
    );
    expect(
      makeReservedQueuedPromptFlushCommand({
        ...input,
        thread: {
          ...value,
          pendingTurnControlOperation: { ...input.operation, state: "ambiguous" },
        },
      }),
    ).toBeNull();
  });
  it.each([
    { operationId: CommandId.makeUnsafe("new-owner") },
    { sessionEpoch: 2 },
    { reservedPromptIds: [prompt("two").id] },
  ])("never lets a delayed handler adopt a changed owner %#", (changed) => {
    const captured = operation({
      strategy: "interrupt-continue",
      state: "waiting-for-settlement",
      sessionEpoch: 0,
    });
    const current = thread({
      session: null,
      pendingTurnControlOperation: { ...captured, ...changed },
    });
    expect(
      makeReservedQueuedPromptFlushCommand({ thread: current, operation: captured, revision: 2 }),
    ).toBeNull();
  });
});
