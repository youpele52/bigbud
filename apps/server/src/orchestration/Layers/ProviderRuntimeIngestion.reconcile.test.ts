import { ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  buildStartupReconciliationCommands,
  buildThreadReconciliationCommand,
} from "./ProviderRuntimeIngestion.reconcile.ts";

const occurredAt = "2026-08-04T00:00:00.000Z";

const deletingThreadId = ThreadId.makeUnsafe("startup-deleting-thread");
const deletingThread = {
  id: deletingThreadId,
  deletingAt: occurredAt,
  deletedAt: null,
  session: null,
  runtimeMode: "full-access",
} as import("@bigbud/contracts").OrchestrationThread;

describe("provider startup reconciliation", () => {
  it("reconciles a stale running projection to the live idle session", () => {
    const thread = {
      id: ThreadId.makeUnsafe("thread-live-idle"),
      deletedAt: null,
      deletingAt: null,
      runtimeMode: "full-access",
      session: {
        threadId: ThreadId.makeUnsafe("thread-live-idle"),
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: TurnId.makeUnsafe("turn-stale"),
        reason: null,
        lastError: null,
        updatedAt: occurredAt,
      },
    } as unknown as import("@bigbud/contracts").OrchestrationThread;

    expect(
      buildThreadReconciliationCommand({
        thread,
        liveSession: {
          threadId: thread.id,
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        occurredAt,
      }),
    ).toMatchObject({
      type: "thread.session.set",
      session: { status: "ready", activeTurnId: null, providerName: "codex" },
    });
  });

  it("does not abort or reconcile retention/purge-owned deletions", () => {
    expect(
      buildStartupReconciliationCommands({
        threads: [deletingThread],
        liveSessions: [],
        deletionOwnedThreadIds: new Set([deletingThreadId]),
        occurredAt,
      }),
    ).toEqual([]);
  });

  it("continues abort recovery for unowned stale deletions", () => {
    expect(
      buildStartupReconciliationCommands({
        threads: [deletingThread],
        liveSessions: [],
        occurredAt,
      }).map((command) => command.type),
    ).toEqual(["thread.delete.abort"]);
  });
});
