import { ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  buildStartupReconciliationCommands,
  buildThreadReconciliationCommand,
  dispatchReconciliationCommandSafely,
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
  it("preserves a supervisor health projection while the provider still reports the turn", () => {
    const threadId = ThreadId.makeUnsafe("stalled-projection-thread");
    const turnId = TurnId.makeUnsafe("stalled-projection-turn");
    const thread = {
      id: threadId,
      deletedAt: null,
      deletingAt: null,
      runtimeMode: "full-access",
      session: {
        threadId,
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        reason: "provider.stalled",
        lastError: "Status cannot be confirmed",
        updatedAt: occurredAt,
      },
    } as unknown as import("@bigbud/contracts").OrchestrationThread;
    const command = buildThreadReconciliationCommand({
      thread,
      liveSession: {
        threadId,
        provider: "codex",
        status: "running",
        runtimeMode: "full-access",
        activeTurnId: turnId,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      occurredAt,
    });

    expect(command).toBeNull();
  });

  it("contains one dispatch failure so later reconciliation commands still run", async () => {
    const firstThreadId = ThreadId.makeUnsafe("dispatch-failure-first");
    const secondThreadId = ThreadId.makeUnsafe("dispatch-failure-second");
    const commands = [firstThreadId, secondThreadId].map((threadId) =>
      buildThreadReconciliationCommand({
        thread: {
          id: threadId,
          deletedAt: null,
          deletingAt: null,
          runtimeMode: "full-access",
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.makeUnsafe(`stale-${threadId}`),
            reason: null,
            lastError: null,
            updatedAt: occurredAt,
          },
        } as unknown as import("@bigbud/contracts").OrchestrationThread,
        liveSession: {
          threadId,
          provider: "codex",
          status: "ready",
          runtimeMode: "full-access",
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        occurredAt,
      }),
    );
    const dispatches: string[] = [];
    let shouldFail = true;
    const engine = {
      dispatch: (command: (typeof commands)[number]) => {
        if (command && "threadId" in command) dispatches.push(command.threadId);
        if (shouldFail) {
          shouldFail = false;
          return Effect.die(new Error("dispatch failed"));
        }
        return Effect.succeed({ sequence: 1 });
      },
    };

    await Effect.runPromise(
      Effect.forEach(commands, (command) => dispatchReconciliationCommandSafely(engine, command!), {
        concurrency: 1,
      }),
    );

    expect(dispatches).toEqual([firstThreadId, secondThreadId]);
  });

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
