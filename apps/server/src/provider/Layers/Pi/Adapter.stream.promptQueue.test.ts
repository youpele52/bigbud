import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import { trackPiPromptQueue } from "./Adapter.stream.promptQueue.ts";
import type { ActivePiSession } from "./Adapter.types.ts";

const first = TurnId.makeUnsafe("first");
const second = TurnId.makeUnsafe("second");

it("attributes a pre-0.99 successful acknowledgement without data and rejects stale extension entries", () => {
  const session = {
    process: { supportsAgentSettled: true, supportsPromptDisposition: false },
    activeTurnId: first,
    queuedTurnIds: [second],
    pendingPromptTurnIds: new Set([second]),
  } as ActivePiSession;
  const update = (steering: string[]) =>
    trackPiPromptQueue(session, { type: "queue_update", steering, followUp: [] });
  const response = () =>
    trackPiPromptQueue(session, { type: "response", id: second, command: "prompt", success: true });
  const user = (content: string) =>
    trackPiPromptQueue(session, { type: "message_start", message: { role: "user", content } });
  update(["prior extension"]);
  session.pendingPromptQueueStarts = new Map([[second, session.promptQueue!.sequence]]);
  response();
  update([]);
  user("prior extension");
  expect(session.activeTurnId).toBe(first);

  session.pendingPromptQueueStarts.set(second, session.promptQueue!.sequence);
  update(["Expanded /review template"]);
  response();
  update([]);
  user("Expanded /review template");
  expect(session.activeTurnId).toBe(second);
  expect(session.queuedTurnIds).toEqual([]);
  expect([...session.settlingTurnIds!]).toEqual([first]);
});

it.each([
  ["template /review", "Review the full patch for correctness and regressions"],
  ["skill /skill:review", '<skill name="review">Follow the review workflow</skill>'],
  ["input transformation", "Transformed input with injected context"],
])(
  "attributes %s using the acknowledged canonical queue, ignoring extension input",
  (_kind, expanded) => {
    const session = {
      threadId: ThreadId.makeUnsafe("queue"),
      process: { supportsAgentSettled: true },
      activeTurnId: first,
      queuedTurnIds: [second],
      pendingPromptTurnIds: new Set([first, second]),
    } as ActivePiSession;
    const update = (steering: string[]) =>
      trackPiPromptQueue(session, { type: "queue_update", steering, followUp: [] });
    const user = (text: string) =>
      trackPiPromptQueue(session, {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text }] },
      });
    // Extensions can queue input while the input handler is processing the submitted prompt.
    update(["Extension before"]);
    update(["Extension before", expanded]);
    trackPiPromptQueue(session, {
      type: "response",
      id: second,
      command: "prompt",
      success: true,
      data: { disposition: "queued" },
    });
    update(["Extension before", expanded, "Extension after"]);
    update([expanded, "Extension after"]);
    user("Extension before");
    expect(session.activeTurnId).toBe(first);
    // A custom extension message must not consume a pending user turn either.
    trackPiPromptQueue(session, {
      type: "message_start",
      message: { role: "custom", content: expanded },
    });
    expect(session.activeTurnId).toBe(first);
    update(["Extension after"]);
    user(expanded);
    expect(session.activeTurnId).toBe(second);
    expect(session.queuedTurnIds).toEqual([]);
    expect([...session.settlingTurnIds!]).toEqual([first]);
    update([]);
    user("Extension after");
    expect(session.activeTurnId).toBe(second);
  },
);

it("does not give an identical extension message ownership of a queued user turn", () => {
  const session = {
    process: { supportsAgentSettled: true },
    activeTurnId: first,
    queuedTurnIds: [second],
    pendingPromptTurnIds: new Set([second]),
  } as ActivePiSession;
  const update = (steering: string[]) =>
    trackPiPromptQueue(session, { type: "queue_update", steering, followUp: [] });
  const user = () =>
    trackPiPromptQueue(session, {
      type: "message_start",
      message: { role: "user", content: "identical" },
    });
  update(["identical"]);
  update(["identical", "identical"]);
  trackPiPromptQueue(session, {
    type: "response",
    id: second,
    command: "prompt",
    success: true,
    data: { disposition: "queued" },
  });
  update(["identical"]);
  user();
  expect(session.activeTurnId).toBe(first);
  update([]);
  user();
  expect(session.activeTurnId).toBe(second);
});
