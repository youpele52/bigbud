import { expect, it } from "vitest";
import { EventId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { firstProviderTurnFailure, PROVIDER_TURN_FAILURE_NOTICE_KIND } from "./providerTurnFailure";
import { deriveWorkLogEntries } from "./workLog/workLog";

it("renders the notice only for its backend run, never as a duplicate work log error", () => {
  const activity: OrchestrationThreadActivity = {
    id: EventId.makeUnsafe("failed-turn"),
    createdAt: "2026-10-17T21:27:53.000Z",
    tone: "error",
    kind: PROVIDER_TURN_FAILURE_NOTICE_KIND,
    summary: "Turn failed",
    payload: { serverRunId: "boot", message: "Safe failure" },
    turnId: null,
  };
  expect(firstProviderTurnFailure([activity], "boot")).toBe("Safe failure");
  expect(firstProviderTurnFailure([activity], "restart")).toBeNull();
  expect(deriveWorkLogEntries([activity], undefined)).toEqual([]);
  expect(
    firstProviderTurnFailure(
      [{ ...activity, payload: { serverRunId: "boot", message: 42 } }],
      "boot",
    ),
  ).toBeNull();
});
