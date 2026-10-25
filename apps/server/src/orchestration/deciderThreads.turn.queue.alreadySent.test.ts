import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideThreadQueueCommand } from "./deciderThreads.turn.queue.ts";
import { decideThreadTurnStartCommand } from "./deciderThreads.turn.start.ts";
import { now, readModel, threadId } from "./deciderThreads.turn.queue.test.helpers.ts";

type Events = ReadonlyArray<Omit<OrchestrationEvent, "sequence">>;

const SENT_ID = MessageId.makeUnsafe("sent");
const sent = {
  id: SENT_ID,
  role: "user" as const,
  text: "Already in the transcript",
  turnId: null,
  streaming: false,
  createdAt: now,
  updatedAt: now,
};
const running = {
  threadId,
  status: "running" as const,
  providerName: "codex" as const,
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
};

const submit = (
  overrides: { readonly redeliverSentMessage?: boolean; readonly id?: string } = {},
) => ({
  type: "thread.message.submit" as const,
  commandId: CommandId.makeUnsafe(`submit-${overrides.id ?? "sent"}`),
  threadId,
  message: { messageId: MessageId.makeUnsafe(overrides.id ?? "sent"), text: sent.text },
  ...(overrides.redeliverSentMessage ? { redeliverSentMessage: true } : {}),
  delivery: "queue" as const,
  createdAt: now,
});

const visible = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: MessageId.makeUnsafe(`queued-${index}`),
    text: `Prompt ${index}`,
    createdAt: now,
  }));

const types = (events: unknown) =>
  (Array.isArray(events) ? (events as Events) : [events as Events[number]]).map(
    (event) => event.type,
  );

describe("already-sent message redelivery", () => {
  it("ignores an ordinary submit for a message already in the transcript", async () => {
    for (const session of [null, running]) {
      const events = await Effect.runPromise(
        decideThreadQueueCommand({
          command: { ...submit(), delivery: "auto" },
          readModel: readModel({ messages: [sent], session }),
        }),
      );
      expect(events).toEqual([]);
    }
  });

  it("ignores a blocked turn start for a message already in the transcript", async () => {
    const events = await Effect.runPromise(
      decideThreadTurnStartCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("retry"),
          threadId,
          message: { messageId: SENT_ID, role: "user", text: sent.text, attachments: [] },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: now,
        },
        readModel: readModel({ messages: [sent], session: running }),
      }),
    );
    expect(events).toEqual([]);
  });

  it("queues the server's busy redelivery as already sent and idempotently", async () => {
    const model = readModel({ messages: [sent], session: running });
    const event = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit({ redeliverSentMessage: true }),
        readModel: model,
      }),
    );
    expect(event).toMatchObject({
      type: "thread.prompt-queued",
      payload: { prompt: { id: "sent", alreadySent: true } },
    });
    const prompt = (event as Extract<OrchestrationEvent, { type: "thread.prompt-queued" }>).payload
      .prompt;
    const repeated = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit({ redeliverSentMessage: true }),
        readModel: readModel({ messages: [sent], session: running, queuedPrompts: [prompt] }),
      }),
    );
    expect(repeated).toEqual([]);
  });

  it("rejects redelivery of a message that is not a sent user message", async () => {
    await expect(
      Effect.runPromise(
        decideThreadQueueCommand({
          command: submit({ redeliverSentMessage: true, id: "missing" }),
          readModel: readModel({ messages: [sent], session: running }),
        }),
      ),
    ).rejects.toThrow("Only a user message already in the thread can be redelivered.");
  });

  it("keeps redeliveries outside the five-prompt limit", async () => {
    const full = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit({ redeliverSentMessage: true }),
        readModel: readModel({ messages: [sent], session: running, queuedPrompts: visible(5) }),
      }),
    );
    expect(types(full)).toEqual(["thread.prompt-queued"]);

    const withRedelivery = await Effect.runPromise(
      decideThreadQueueCommand({
        command: submit({ id: "fresh" }),
        readModel: readModel({
          messages: [sent],
          session: running,
          queuedPrompts: [{ ...visible(1)[0]!, id: SENT_ID, alreadySent: true }, ...visible(4)],
        }),
      }),
    );
    expect(types(withRedelivery)).toEqual(["thread.prompt-queued"]);
  });

  it("flushes an already-sent prompt alone under its own message ID", async () => {
    const events = await Effect.runPromise(
      decideThreadQueueCommand({
        command: {
          type: "thread.queued-prompt.flush",
          commandId: CommandId.makeUnsafe("flush"),
          threadId,
          messageIds: [SENT_ID, MessageId.makeUnsafe("queued-0")],
          messageId: MessageId.makeUnsafe("queue-message:digest"),
          createdAt: now,
        },
        readModel: readModel({
          messages: [sent],
          queuedPrompts: [
            { id: SENT_ID, text: sent.text, createdAt: now, alreadySent: true },
            ...visible(1),
          ],
        }),
      }),
    );
    expect(types(events)).toEqual([
      "thread.queued-prompts-flushed",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect((events as Events)[0]).toMatchObject({ payload: { messageIds: [SENT_ID] } });
    expect((events as Events)[1]).toMatchObject({
      payload: { messageId: SENT_ID, text: sent.text },
    });
  });
});
