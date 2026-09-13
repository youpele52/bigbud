import { CommandId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationCommand } from "@bigbud/contracts/orchestration/orchestration.commands.ts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makePrepareCommandState } from "./OrchestrationEngine.prepareCommandState.ts";

const threadId = ThreadId.makeUnsafe("target");
const sourceId = ThreadId.makeUnsafe("source");
const command = {
  type: "thread.message.submit",
  commandId: CommandId.makeUnsafe("submit"),
  threadId,
  message: { messageId: MessageId.makeUnsafe("message"), text: "continue" },
  delivery: "auto",
  createdAt: "2026-09-11T00:00:00.000Z",
} satisfies OrchestrationCommand;

describe("prepare message submission state", () => {
  it("keeps ordinary submissions on bounded operational state", async () => {
    const load = vi.fn(() => Effect.sync(() => undefined));
    await Effect.runPromise(makePrepareCommandState({ threadStateHydrator: { load } })(command));
    expect(load.mock.calls).toEqual([[threadId, "operational"]]);
  });

  it("loads reply history before validating a message submission", async () => {
    const load = vi.fn(() => Effect.sync(() => undefined));
    await Effect.runPromise(
      makePrepareCommandState({ threadStateHydrator: { load } })({
        ...command,
        message: { ...command.message, replyToMessageId: MessageId.makeUnsafe("reply") },
      }),
    );
    expect(load.mock.calls).toEqual([[threadId, "history"]]);
  });

  it("loads the source plan's thread without loading unrelated target history", async () => {
    const load = vi.fn(() => Effect.sync(() => undefined));
    await Effect.runPromise(
      makePrepareCommandState({ threadStateHydrator: { load } })({
        ...command,
        sourceProposedPlan: { threadId: sourceId, planId: "plan" },
      }),
    );
    expect(load.mock.calls).toEqual([
      [threadId, "operational"],
      [sourceId, "history"],
    ]);
  });

  it("loads same-thread source plan history only once", async () => {
    const load = vi.fn(() => Effect.sync(() => undefined));
    await Effect.runPromise(
      makePrepareCommandState({ threadStateHydrator: { load } })({
        ...command,
        sourceProposedPlan: { threadId, planId: "plan" },
      }),
    );
    expect(load.mock.calls).toEqual([[threadId, "history"]]);
  });

  it("deduplicates reply and source-plan history on the same thread", async () => {
    const load = vi.fn(() => Effect.sync(() => undefined));
    await Effect.runPromise(
      makePrepareCommandState({ threadStateHydrator: { load } })({
        ...command,
        message: { ...command.message, replyToMessageId: MessageId.makeUnsafe("reply") },
        sourceProposedPlan: { threadId, planId: "plan" },
      }),
    );
    expect(load.mock.calls).toEqual([[threadId, "history"]]);
  });
});
