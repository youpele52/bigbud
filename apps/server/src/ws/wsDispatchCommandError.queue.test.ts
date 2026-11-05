import { expect, it } from "vitest";
import { toDispatchCommandError } from "./wsDispatchCommandError.ts";
import { queueDecisionError } from "../orchestration/QueuedPromptDecision.logic.ts";
import { OrchestrationCommandPreviouslyRejectedError } from "../orchestration/Errors.ts";

it("preserves the same structured refusal on direct dispatch and receipt replay", () => {
  const original = queueDecisionError("queue_pending_start");
  const replay = new OrchestrationCommandPreviouslyRejectedError({
    commandId: "replay",
    detail: original.message,
    queueReason: "queue_pending_start",
  });
  for (const error of [original, replay]) {
    expect(toDispatchCommandError(error, "fallback")).toMatchObject({
      code: "queue_pending_start",
      message: "The previous turn is still starting. Your prompts remain queued.",
    });
  }
});
