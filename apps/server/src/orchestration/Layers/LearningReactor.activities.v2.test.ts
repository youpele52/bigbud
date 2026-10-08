import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ThreadId, TurnId } from "@bigbud/contracts";
import { makeLearningActivityPublisher } from "./LearningReactor.activities.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

it("learning activities report selected/actual V2 identity only when result validation succeeds, never fallback identity", async () => {
  const dispatch = vi.fn((_command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
    Effect.succeed({ sequence: 1 }),
  );
  const publisher = makeLearningActivityPublisher({ dispatch } as Pick<
    OrchestrationEngineShape,
    "dispatch"
  > as OrchestrationEngineShape);
  const job = {
    jobId: "activity-v2",
    threadId: ThreadId.makeUnsafe("activity-v2"),
    turnId: TurnId.makeUnsafe("activity-v2"),
    attemptCount: 1,
    memoryUserMessageCount: 15,
    provider: "opencodeV2" as const,
  };
  await Effect.runPromise(publisher.started(job));
  await Effect.runPromise(publisher.outcome(job, "unchanged", "Reviewed"));
  await Effect.runPromise(publisher.outcome(job, "failed", "Cleanup unconfirmed"));
  const payloads = dispatch.mock.calls.map(
    ([command]) =>
      (
        command as Extract<
          Parameters<OrchestrationEngineShape["dispatch"]>[0],
          { type: "thread.activity.append" }
        >
      ).activity.payload,
  );
  expect(payloads[0]).toMatchObject({ requestedProvider: "opencodeV2" });
  expect(payloads[0]).not.toHaveProperty("actualProvider");
  expect(payloads[1]).toMatchObject({
    requestedProvider: "opencodeV2",
    actualProvider: "opencodeV2",
  });
  expect(payloads[2]).not.toHaveProperty("actualProvider");
});
