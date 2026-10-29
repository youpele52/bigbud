import { CommandId, ThreadId } from "@bigbud/contracts";
import { expect, it } from "vitest";
import { OrchestrationCommandOutcomeError } from "./orchestrationCommandRecovery.dispatch";

it("retains a factual queue reason when recovering a lost dispatch response", () => {
  const error = new OrchestrationCommandOutcomeError({
    commandId: CommandId.makeUnsafe("queue-attempt"),
    status: "rejected",
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread"),
    rejectedAt: "2026-10-28T12:00:00.000Z",
    resultSequence: 1,
    reason: "queue_pending_start",
    serverEpoch: "server",
    canonicalRevision: 1,
  });
  expect(error.code).toBe("queue_pending_start");
  expect(error.message).toBe("The previous turn is still starting. Your prompts remain queued.");
});
