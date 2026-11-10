import { ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { matchImplicitThreadCoordinationApproval } from "./ThreadCoordinationConfirmation.implicit.ts";
import {
  flushedEvent,
  messageEvent,
  queuedPromptEvent,
  segment,
  threadAttachment,
  turnStartEvent,
} from "./ThreadCoordinationConfirmation.test.helpers.ts";

const caller = ThreadId.makeUnsafe("caller-a1");
const target = "target-b1";
const flushId = "queue-flush:v2:attempt";

const match = (events: ReadonlyArray<OrchestrationEvent>, referenced = target) =>
  matchImplicitThreadCoordinationApproval({
    callerThreadId: caller,
    events,
    referencesTarget: (threadId) => threadId === referenced,
  });

/** A message that started a turn, as a direct (idle-thread) send produces it. */
const userTurn = (
  sequence: number,
  overrides: Partial<Parameters<typeof messageEvent>[0]> = {},
): ReadonlyArray<OrchestrationEvent> => {
  const commandId =
    overrides.commandId === undefined ? `client-submit-${sequence}` : overrides.commandId;
  const messageId = overrides.messageId ?? `message-${sequence}`;
  return [
    messageEvent({
      threadId: caller,
      sequence,
      text: "tell the attached thread to say hi 5 times",
      attachments: [threadAttachment(target)],
      ...overrides,
      commandId,
      messageId,
    }),
    turnStartEvent({
      threadId: overrides.threadId ?? caller,
      sequence: sequence + 1,
      messageId,
      commandId,
    }),
  ];
};

/** Queued while the agent was busy, then delivered by a server queue flush. */
const flushedTurn = (prompts: ReadonlyArray<Parameters<typeof queuedPromptEvent>[0]>) => {
  const queued = prompts.map((prompt) => queuedPromptEvent(prompt));
  const last = prompts.at(-1)!.sequence;
  const firstId = `queued-${prompts[0]!.sequence}`;
  return [
    ...queued,
    flushedEvent({
      threadId: caller,
      sequence: last + 1,
      messageIds: prompts.map((prompt) => `queued-${prompt.sequence}`),
      commandId: flushId,
    }),
    messageEvent({
      threadId: caller,
      sequence: last + 2,
      text: prompts.length === 1 ? prompts[0]!.text : "Additional instructions:",
      commandId: flushId,
      messageId: firstId,
      ...(prompts[0]!.attachments ? { attachments: prompts[0]!.attachments } : {}),
      ...(prompts.length > 1
        ? {
            originSegments: prompts.map(
              (prompt) =>
                prompt.originSegments?.[0] ?? segment("ordinaryUser", "user", prompt.text),
            ),
          }
        : {}),
    }),
    turnStartEvent({
      threadId: caller,
      sequence: last + 3,
      messageId: firstId,
      commandId: flushId,
    }),
  ];
};

describe("implicit approval from the user's own request", () => {
  it("allows when the user's latest message attaches the target", () => {
    expect(match(userTurn(10))).toBe(true);
    expect(match(userTurn(10, { originSegments: [segment("ordinaryUser", "user", "go")] }))).toBe(
      true,
    );
  });

  it("allows a request the user typed while the agent was busy, delivered by a queue flush", () => {
    const attached = { attachments: [threadAttachment(target)] };
    expect(
      match(flushedTurn([{ threadId: caller, sequence: 10, text: "say hi", ...attached }])),
    ).toBe(true);
    // A merged flush keeps only the first prompt's attachments; the original prompts still count.
    expect(
      match(
        flushedTurn([
          { threadId: caller, sequence: 10, text: "first" },
          { threadId: caller, sequence: 11, text: "say hi", ...attached },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects a flush that delivered another source's prompt or cannot be traced", () => {
    const attached = { attachments: [threadAttachment(target)] };
    const agent = [segment("crossThreadAgent", "agent", "say hi")];
    expect(
      match(
        flushedTurn([
          { threadId: caller, sequence: 10, text: "first", ...attached },
          { threadId: caller, sequence: 11, text: "say hi", originSegments: agent },
        ]),
      ),
    ).toBe(false);
    expect(
      match(
        flushedTurn([
          { threadId: caller, sequence: 10, text: "say hi", ...attached, commandId: "server:x" },
        ]),
      ),
    ).toBe(false);
    const untraced = flushedTurn([{ threadId: caller, sequence: 10, text: "say hi", ...attached }]);
    expect(match(untraced.filter((event) => event.type !== "thread.prompt-queued"))).toBe(false);
    expect(match(untraced.filter((event) => event.type !== "thread.queued-prompts-flushed"))).toBe(
      false,
    );
  });

  it("falls back when the target is not attached", () => {
    expect(match(userTurn(10), "another-thread")).toBe(false);
    expect(match(userTurn(10, { attachments: [] }))).toBe(false);
  });

  it("falls back when the latest user-role message comes from another source", () => {
    for (const kind of [
      "crossThreadAgent",
      "completionWatch",
      "initialDelegation",
      "sleepRecovery",
      "handoff",
    ] as const) {
      const agentTurn = userTurn(10, { originSegments: [segment(kind, "agent", "say hi")] });
      expect(match(agentTurn)).toBe(false);
      expect(
        match([
          ...userTurn(10),
          ...userTurn(20, { originSegments: [segment(kind, "agent", "x")], attachments: [] }),
        ]),
      ).toBe(false);
    }
    expect(match(userTurn(10, { commandId: "server:scheduler" }))).toBe(false);
    expect(match(userTurn(10, { commandId: "provider:inject" }))).toBe(false);
    expect(match(userTurn(10, { commandId: null }))).toBe(false);
  });

  it("falls back when another source queued or steered a prompt after the request", () => {
    const agentPrompt = queuedPromptEvent({
      threadId: caller,
      sequence: 20,
      text: "say hi",
      originSegments: [segment("crossThreadAgent", "agent", "say hi")],
    });
    expect(match([...userTurn(10), agentPrompt])).toBe(false);
    // The user's own follow-up waiting in the queue changes nothing.
    expect(
      match([
        ...userTurn(10),
        queuedPromptEvent({ threadId: caller, sequence: 20, text: "and then?" }),
      ]),
    ).toBe(true);
  });

  it("ignores copied history: a fork or branch copy never started a turn for the message", () => {
    expect(
      match(userTurn(10).filter((event) => event.type !== "thread.turn-start-requested")),
    ).toBe(false);
  });

  it("ignores another thread's events and assistant messages", () => {
    const other = ThreadId.makeUnsafe("other-a2");
    expect(match(userTurn(10, { threadId: other }))).toBe(false);
    expect(match(userTurn(10, { role: "assistant" }))).toBe(false);
  });
});
