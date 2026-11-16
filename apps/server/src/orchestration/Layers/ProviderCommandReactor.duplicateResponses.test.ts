/**
 * A mobile client may answer an approval twice: once more after a lost
 * acknowledgement (same command ID), or again after a reload that forgot the
 * first send (new command ID). Only the first must reach the provider through
 * the command receipt. A new command ID is forwarded, and the provider's
 * stale-request rejection is what prevents a second effect.
 */
import { CommandId, EventId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asApprovalRequestId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");

async function harnessWithPendingApproval() {
  const harness = await createHarness();
  const now = new Date().toISOString();
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe("cmd-session-set"),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      },
      createdAt: now,
    }),
  );
  await Effect.runPromise(
    harness.engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe("cmd-approval-requested"),
      threadId,
      activity: {
        id: EventId.makeUnsafe("activity-approval-requested"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: { requestId: "approval-request-1", requestKind: "command" },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    }),
  );
  const respond = (commandId: string) =>
    Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.makeUnsafe(commandId),
        threadId,
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );
  return { harness, respond };
}

describe("ProviderCommandReactor duplicate approval responses", () => {
  registerProviderCommandReactorTestCleanup();

  it("forwards a same-ID resend to the provider only once", async () => {
    const { harness, respond } = await harnessWithPendingApproval();

    const first = await respond("cmd-approval-respond-1");
    await waitFor(() => harness.respondToRequest.mock.calls.length >= 1);
    // The phone re-sends the identical command after losing the acknowledgement.
    const resend = await respond("cmd-approval-respond-1");

    expect(resend).toEqual(first);
    // Give the reactor time to (wrongly) process a second intent.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(harness.respondToRequest).toHaveBeenCalledTimes(1);
  });

  it("forwards a new-ID repeat, leaving the provider to reject the stale request", async () => {
    const { harness, respond } = await harnessWithPendingApproval();

    await respond("cmd-approval-respond-1");
    await waitFor(() => harness.respondToRequest.mock.calls.length >= 1);
    await respond("cmd-approval-respond-2");

    await waitFor(() => harness.respondToRequest.mock.calls.length >= 2);
    expect(harness.respondToRequest).toHaveBeenCalledTimes(2);
  });
});
