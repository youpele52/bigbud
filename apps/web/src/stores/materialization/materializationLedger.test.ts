import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import type { LedgerStorage } from "../ledger/revisionedLedger";
import {
  beginMaterializationAttempt,
  clearMaterializationAttempt,
  MATERIALIZATION_LEDGER_KEY,
  MATERIALIZATION_LEDGER_MAX_ATTEMPTS,
  MaterializationLedgerOverloadedError,
  readMaterializationLedger,
  setMaterializationAttemptStatus,
} from "./materializationLedger";

function memoryStorage(): LedgerStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function attemptInput(index: number) {
  const threadId = ThreadId.makeUnsafe(`thread-${index}`);
  return {
    threadId,
    projectId: ProjectId.makeUnsafe("project-1"),
    aggregateKind: "thread" as const,
    aggregateId: threadId,
    commandId: CommandId.makeUnsafe(`command-${index}`),
    messageId: MessageId.makeUnsafe(`message-${index}`),
    kind: "turn" as const,
    createdAt: `2026-08-26T12:00:${String(index).padStart(2, "0")}.000Z`,
    requestDigest: `sha256:${index}`,
    serverEpoch: "server-epoch",
    ownershipRevision: 7,
  };
}

function ready(storage: LedgerStorage) {
  const result = readMaterializationLedger(storage);
  if (result.status !== "ready") throw new Error(`Unexpected ${result.reason} ledger`);
  return result.value;
}

describe("materializationLedger", () => {
  it("persists stable identities across a dispatching restart", async () => {
    const storage = memoryStorage();
    const attempt = await beginMaterializationAttempt(attemptInput(1), { storage });
    await setMaterializationAttemptStatus(
      attempt.threadId,
      attempt.generation,
      "dispatching",
      null,
      {
        storage,
      },
    );

    expect(ready(storage).attemptsByThreadId[attempt.threadId]).toMatchObject({
      commandId: attempt.commandId,
      messageId: attempt.messageId,
      requestDigest: attempt.requestDigest,
      aggregateId: attempt.threadId,
      status: "dispatching",
    });
  });

  it("keeps generations monotonic after clear and rejects stale ABA mutations", async () => {
    const storage = memoryStorage();
    const first = await beginMaterializationAttempt(attemptInput(1), { storage });
    await clearMaterializationAttempt(first.threadId, first.generation, { storage });
    const second = await beginMaterializationAttempt(attemptInput(1), { storage });

    expect(second.generation).toBeGreaterThan(first.generation);
    expect(
      await setMaterializationAttemptStatus(first.threadId, first.generation, "dispatching", null, {
        storage,
      }),
    ).toBe(false);
    expect(ready(storage).attemptsByThreadId[first.threadId]?.generation).toBe(second.generation);
  });

  it("treats malformed state as unavailable without overwriting raw evidence", async () => {
    const storage = memoryStorage();
    storage.setItem(MATERIALIZATION_LEDGER_KEY, "{malformed");

    expect(readMaterializationLedger(storage)).toEqual({
      status: "unavailable",
      reason: "corrupt",
    });
    await expect(beginMaterializationAttempt(attemptInput(1), { storage })).rejects.toThrow(
      "Ledger unavailable: corrupt",
    );
    expect(storage.getItem(MATERIALIZATION_LEDGER_KEY)).toBe("{malformed");
  });

  it("refuses capacity instead of evicting unresolved attempts", async () => {
    const storage = memoryStorage();
    for (let index = 0; index < MATERIALIZATION_LEDGER_MAX_ATTEMPTS; index += 1) {
      await beginMaterializationAttempt(attemptInput(index), { storage });
    }
    await expect(
      beginMaterializationAttempt(attemptInput(MATERIALIZATION_LEDGER_MAX_ATTEMPTS), { storage }),
    ).rejects.toBeInstanceOf(MaterializationLedgerOverloadedError);
    expect(Object.keys(ready(storage).attemptsByThreadId)).toHaveLength(
      MATERIALIZATION_LEDGER_MAX_ATTEMPTS,
    );
  });

  it("serializes two window mutations through the shared lock boundary", async () => {
    const storage = memoryStorage();
    let tail = Promise.resolve();
    const lockManager = {
      request: async <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => (release = resolve));
        await previous;
        try {
          return await callback();
        } finally {
          release();
        }
      },
    };
    const [first, second] = await Promise.all([
      beginMaterializationAttempt(attemptInput(1), { storage, lockManager }),
      beginMaterializationAttempt(attemptInput(2), { storage, lockManager }),
    ]);

    expect(Object.keys(ready(storage).attemptsByThreadId)).toEqual([
      first.threadId,
      second.threadId,
    ]);
    expect(second.generation).toBeGreaterThan(first.generation);
  });
});
