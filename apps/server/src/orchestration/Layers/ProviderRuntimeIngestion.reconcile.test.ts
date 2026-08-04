import { ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { buildStartupReconciliationCommands } from "./ProviderRuntimeIngestion.reconcile.ts";

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
