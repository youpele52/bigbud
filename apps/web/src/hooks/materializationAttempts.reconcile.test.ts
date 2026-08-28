import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginMaterializationAttempt,
  readMaterializationLedger,
} from "../stores/materialization/materializationLedger";
import { reconcilePersistedMaterializationAttempts } from "./materializationAttempts.reconcile";

const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ProjectId.makeUnsafe("project-1");

function seedAttempt() {
  return beginMaterializationAttempt({
    threadId,
    projectId,
    aggregateKind: "thread",
    aggregateId: threadId,
    commandId: CommandId.makeUnsafe("command-1"),
    messageId: MessageId.makeUnsafe("message-1"),
    kind: "turn",
    createdAt: "2026-08-26T12:00:00.000Z",
    requestDigest: "sha256:request",
    serverEpoch: "server-1",
    ownershipRevision: 2,
  });
}

function seedExistingThreadAttempt() {
  return beginMaterializationAttempt({
    threadId,
    projectId,
    aggregateKind: "thread",
    aggregateId: threadId,
    commandId: CommandId.makeUnsafe("command-1"),
    messageId: MessageId.makeUnsafe("message-1"),
    kind: "turn",
    createdAt: "2026-08-26T12:00:00.000Z",
    requestDigest: "sha256:request",
    serverEpoch: "server-1",
    ownershipRevision: 2,
    requiresOutcome: true,
  });
}

describe("reconcilePersistedMaterializationAttempts", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function readAttempt() {
    const ledger = readMaterializationLedger();
    if (ledger.status !== "ready") throw new Error("ledger unavailable");
    return ledger.value.attemptsByThreadId[threadId];
  }

  it("clears an accepted attempt only after canonical ownership is discovered", async () => {
    await seedAttempt();
    const reconcileCanonical = vi.fn();
    const summary = await reconcilePersistedMaterializationAttempts({
      api: {
        orchestration: {
          getCommandOutcome: vi.fn(async () => ({
            status: "accepted" as const,
            aggregateKind: "thread" as const,
            aggregateId: threadId,
            resultSequence: 8,
          })),
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            projectId,
            status: "active" as const,
            serverEpoch: "server-1",
            canonicalRevision: 8,
          })),
        } as never,
      },
      callbacks: { reconcileCanonical, replaceCollision: vi.fn() },
    });

    expect(summary.accepted).toBe(1);
    expect(reconcileCanonical).toHaveBeenCalledWith(threadId);
    expect(readAttempt()).toBeUndefined();
  });

  it("retains accepted-awaiting-event across restart while the canonical event is missing", async () => {
    await seedAttempt();
    const summary = await reconcilePersistedMaterializationAttempts({
      api: {
        orchestration: {
          getCommandOutcome: vi.fn(async () => ({
            status: "accepted" as const,
            aggregateKind: "thread" as const,
            aggregateId: threadId,
            resultSequence: 8,
          })),
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            status: "absent" as const,
            serverEpoch: "server-1",
            canonicalRevision: 7,
          })),
        } as never,
      },
      callbacks: { reconcileCanonical: vi.fn(), replaceCollision: vi.fn() },
    });

    expect(summary.pending).toBe(1);
    expect(readAttempt()).toMatchObject({
      status: "accepted-awaiting-event",
      acceptedSequence: 8,
      commandId: "command-1",
      messageId: "message-1",
    });
  });

  it("retains an accepted outcome when ownership resolution is temporarily unavailable", async () => {
    await seedAttempt();
    const summary = await reconcilePersistedMaterializationAttempts({
      api: {
        orchestration: {
          getCommandOutcome: vi.fn(async () => ({
            status: "accepted" as const,
            aggregateKind: "thread" as const,
            aggregateId: threadId,
            resultSequence: 8,
          })),
          resolveThreadOwnership: vi.fn(async () => {
            throw new Error("transport unavailable");
          }),
        } as never,
      },
      callbacks: { reconcileCanonical: vi.fn(), replaceCollision: vi.fn() },
    });

    expect(summary.pending).toBe(1);
    expect(readAttempt()).toMatchObject({
      status: "accepted-awaiting-event",
      acceptedSequence: 8,
    });
  });

  it("keeps an unknown attempt when authoritative ownership remains absent", async () => {
    await seedAttempt();
    const summary = await reconcilePersistedMaterializationAttempts({
      api: {
        orchestration: {
          getCommandOutcome: vi.fn(async () => ({ status: "unknown" as const })),
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            status: "absent" as const,
            serverEpoch: "server-1",
            canonicalRevision: 3,
          })),
        } as never,
      },
      callbacks: { reconcileCanonical: vi.fn(), replaceCollision: vi.fn() },
    });

    expect(summary.pending).toBe(1);
    expect(readAttempt()).toMatchObject({
      status: "ambiguous",
      commandId: "command-1",
      messageId: "message-1",
    });
  });

  it("keeps an unknown existing-thread command pending until its outcome is known", async () => {
    await seedExistingThreadAttempt();
    const reconcileCanonical = vi.fn();
    const summary = await reconcilePersistedMaterializationAttempts({
      api: {
        orchestration: {
          getCommandOutcome: vi.fn(async () => ({ status: "unknown" as const })),
          resolveThreadOwnership: vi.fn(async () => ({
            threadId,
            projectId,
            status: "active" as const,
            serverEpoch: "server-1",
            canonicalRevision: 3,
          })),
        } as never,
      },
      callbacks: { reconcileCanonical, replaceCollision: vi.fn() },
    });

    expect(summary.pending).toBe(1);
    expect(reconcileCanonical).not.toHaveBeenCalled();
    expect(readAttempt()).toMatchObject({ status: "ambiguous", requiresOutcome: true });
  });
});
