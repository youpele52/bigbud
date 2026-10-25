import { MessageId, ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationThread } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import type { ProviderSession } from "@bigbud/contracts/orchestration/provider.ts";
import { describe, expect, it } from "vitest";

import { buildThreadReconciliationCommand } from "./ProviderRuntimeIngestion.reconcile.ts";

const occurredAt = "2026-10-22T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("gated-thread");

const thread = (pendingTurnStart: OrchestrationThread["pendingTurnStart"]) =>
  ({
    id: threadId,
    deletedAt: null,
    deletingAt: null,
    runtimeMode: "full-access",
    pendingTurnStart,
    session: {
      threadId,
      status: "starting",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      sessionEpoch: 2,
      reason: null,
      lastError: null,
      updatedAt: occurredAt,
    },
  }) as unknown as OrchestrationThread;

const gate = { messageId: MessageId.makeUnsafe("continued"), requestedAt: occurredAt };

describe("reconciliation while a turn start is pending", () => {
  it("does not write stopped over a session the reactor is still starting", () => {
    expect(
      buildThreadReconciliationCommand({
        thread: thread(gate),
        liveSession: undefined,
        occurredAt,
      }),
    ).toBeNull();
  });

  it("still stops a missing session once no start is pending", () => {
    expect(
      buildThreadReconciliationCommand({
        thread: thread(null),
        liveSession: undefined,
        occurredAt,
      }),
    ).toMatchObject({ type: "thread.session.set", session: { status: "stopped" } });
  });

  it("still projects a live turn, which binds the pending start", () => {
    const liveSession = {
      provider: "codex",
      status: "running",
      runtimeMode: "full-access",
      threadId,
      activeTurnId: TurnId.makeUnsafe("turn-ab"),
      sessionEpoch: 2,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    } as ProviderSession;
    expect(
      buildThreadReconciliationCommand({ thread: thread(gate), liveSession, occurredAt }),
    ).toMatchObject({ session: { status: "running", activeTurnId: "turn-ab" } });
  });
});
