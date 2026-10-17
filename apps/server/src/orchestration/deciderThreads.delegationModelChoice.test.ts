import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import {
  alternative,
  apply,
  childId,
  decide,
  expireCommand,
  fallback,
  heldMessageId,
  heldReadModel,
  holdCommand,
  now,
  pickCommand,
} from "./deciderThreads.delegationModelChoice.test.helpers.ts";
import { isThreadTurnDispatchBlocked } from "./ThreadDispatchSafety.logic.ts";

const types = (events: ReadonlyArray<Pick<OrchestrationEvent, "type">>) =>
  events.map((event) => event.type);
const payloadOf = (events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>, type: string) =>
  events.find((event) => event.type === type)?.payload as Record<string, unknown> | undefined;

describe("thread.delegation.model-choice.hold", () => {
  it("queues the delegated message with the fallback and blocks dispatch atomically", async () => {
    const held = await heldReadModel();
    const child = held.threads[0]!;
    expect(child.queuedPrompts?.map((prompt) => prompt.id)).toEqual([heldMessageId]);
    expect(child.queuedPrompts?.[0]?.modelSelection).toEqual(fallback);
    expect(child.queuedPrompts?.[0]?.originSegments?.[0]?.kind).toBe("initialDelegation");
    expect(child.activities.map((activity) => activity.kind)).toEqual([
      "delegation.model-choice-requested",
    ]);
    expect(isThreadTurnDispatchBlocked(child)).toBe(true);
    expect(child.latestTurn).toBeNull();
  });

  it("is idempotent for the same choice and rejected after a first turn", async () => {
    const held = await heldReadModel();
    expect(await decide(held, holdCommand())).toEqual([]);
    const started = {
      ...held,
      threads: [{ ...held.threads[0]!, activities: [], latestTurn: { turnId: "t" } as never }],
    };
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ command: holdCommand(), readModel: started })),
    ).rejects.toThrow(/first turn/);
  });
});

describe("thread.delegation.model-choice.pick and expire", () => {
  it("starts the held message with the picked model; meta-updated precedes the turn", async () => {
    const held = await heldReadModel();
    const events = await decide(held, pickCommand(alternative));
    expect(types(events)).toEqual([
      "thread.activity-appended",
      "thread.meta-updated",
      "thread.queued-prompts-flushed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(payloadOf(events, "thread.turn-start-requested")?.modelSelection).toEqual(alternative);
    const resolved = (
      payloadOf(events, "thread.activity-appended")!.activity as { payload: unknown }
    ).payload;
    expect(resolved).toMatchObject({
      used: alternative,
      outcome: "user-picked",
      resolvedBy: "user",
    });
    const after = await apply(held, events);
    const child = after.threads[0]!;
    expect(child.modelSelection).toEqual(alternative);
    expect(child.queuedPrompts).toEqual([]);
    expect(child.session?.providerName).toBe("claudeAgent");
    expect(child.messages[0]?.originSegments?.[0]?.kind).toBe("initialDelegation");
  });

  it("picking the fallback option records a fallback outcome", async () => {
    const events = await decide(await heldReadModel(), pickCommand(fallback));
    const activity = payloadOf(events, "thread.activity-appended")?.activity as {
      payload: unknown;
    };
    expect(activity.payload).toMatchObject({ outcome: "fallback", resolvedBy: "user" });
  });

  it("expires to the fallback, and the first resolution wins", async () => {
    const held = await heldReadModel();
    const expired = await decide(held, expireCommand());
    expect(payloadOf(expired, "thread.turn-start-requested")?.modelSelection).toEqual(fallback);
    const activity = payloadOf(expired, "thread.activity-appended")?.activity as {
      payload: unknown;
    };
    expect(activity.payload).toMatchObject({ outcome: "fallback", resolvedBy: "timeout" });
    const after = await apply(held, expired);
    expect(await decide(after, pickCommand(alternative))).toEqual([]);
    expect(await decide(after, expireCommand())).toEqual([]);
  });

  it("ignores an unknown choice id", async () => {
    const held = await heldReadModel();
    expect(await decide(held, expireCommand("other"))).toEqual([]);
    expect(await decide(held, pickCommand(alternative, "other"))).toEqual([]);
  });

  it("rejects a pick outside the offered options and never accepts client options", async () => {
    const held = await heldReadModel();
    await expect(
      decide(held, pickCommand({ provider: "copilot", model: "gpt-4.1" })),
    ).rejects.toThrow(/offered/);
    const events = await decide(
      held,
      pickCommand({ ...alternative, options: { effort: "max" } } as never),
    );
    expect(payloadOf(events, "thread.turn-start-requested")?.modelSelection).toEqual(alternative);
  });

  it("records a cancelled resolution when the held message was removed or the thread archived", async () => {
    const held = await heldReadModel();
    const removed = await apply(
      held,
      await decide(held, {
        type: "thread.queued-prompt.remove",
        commandId: CommandId.makeUnsafe("remove"),
        threadId: childId,
        messageId: heldMessageId,
        createdAt: now,
      }),
    );
    const removedEvents = await decide(removed, expireCommand());
    expect(types(removedEvents)).toEqual(["thread.activity-appended", "thread.meta-updated"]);
    expect(
      (payloadOf(removedEvents, "thread.activity-appended")!.activity as { payload: unknown })
        .payload,
    ).toMatchObject({ cancelled: true });

    const archived = { ...held, threads: [{ ...held.threads[0]!, archivedAt: now }] };
    const archivedEvents = await decide(archived, expireCommand());
    expect(types(archivedEvents)).toEqual(["thread.activity-appended", "thread.meta-updated"]);
  });
});

describe("user messages during a hold", () => {
  it("queues direct turn starts and submits behind the delegated message", async () => {
    const held = await heldReadModel();
    const direct = await decide(held, {
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe("user-start"),
      threadId: childId,
      message: {
        messageId: MessageId.makeUnsafe("user-1"),
        role: "user",
        text: "also this",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    });
    expect(types(direct)).toEqual(["thread.prompt-queued"]);
    const afterDirect = await apply(held, direct);
    const submit = await decide(afterDirect, {
      type: "thread.message.submit",
      commandId: CommandId.makeUnsafe("user-submit"),
      threadId: childId,
      message: { messageId: MessageId.makeUnsafe("user-2"), text: "and this" },
      delivery: "auto",
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: now,
    } as never);
    expect(types(submit)).toEqual(["thread.prompt-queued"]);
    const queued = await apply(afterDirect, submit);

    const resolved = await decide(queued, pickCommand(alternative));
    expect(payloadOf(resolved, "thread.queued-prompts-flushed")?.messageIds).toEqual([
      heldMessageId,
    ]);
    const after = await apply(queued, resolved);
    expect(after.threads[0]!.queuedPrompts?.map((prompt) => prompt.id)).toEqual([
      "user-1",
      "user-2",
    ]);
  });
});
