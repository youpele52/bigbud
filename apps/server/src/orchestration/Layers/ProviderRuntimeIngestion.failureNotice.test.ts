import { expect, it } from "vitest";
import {
  firstProviderTurnFailure,
  PROVIDER_TURN_FAILURE_NOTICE_KIND,
} from "@bigbud/shared/providerTurnFailure";
import { serverRunId } from "../../startup/serverRunIdentity.ts";
import {
  asEventId,
  asThreadId,
  asTurnId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

registerProviderRuntimeIngestionTestCleanup();

it("retains a failed V2 turn notice through immediate ready, without assistant output or generic error", async () => {
  const harness = await createHarness({ provider: "opencodeV2" });
  const base = {
    provider: "opencodeV2" as const,
    threadId: asThreadId("thread-1"),
    createdAt: new Date().toISOString(),
    turnId: asTurnId("failed-v2-turn"),
  };
  harness.emit({ ...base, type: "turn.started", eventId: asEventId("v2-start") });
  await waitForThread(harness.engine, (thread) => thread.session?.status === "running");
  const message = "OpenCode v2 native model (HTTP 401): OpenCode Console API key has expired.";
  harness.emit({
    ...base,
    type: "turn.completed",
    eventId: asEventId("v2-fail"),
    payload: { state: "failed", errorMessage: message },
  });
  harness.emit({
    ...base,
    type: "session.state.changed",
    eventId: asEventId("v2-ready"),
    payload: { state: "ready" },
  });
  const thread = await waitForThread(
    harness.engine,
    (entry) =>
      entry.session?.status === "ready" &&
      entry.activities.some((activity) => activity.kind === PROVIDER_TURN_FAILURE_NOTICE_KIND),
  );
  expect(thread.session?.lastError).toBeNull();
  expect(thread.messages.filter((entry) => entry.role === "assistant")).toEqual([]);
  expect(firstProviderTurnFailure(thread.activities, serverRunId)).toBe(message);
  expect(firstProviderTurnFailure(thread.activities, "next-bigbud-run")).toBeNull();
});
