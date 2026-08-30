import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { calculateCommandPayloadDigest } from "../../orchestration/commandDigest.ts";
import { recoverPreparedCleanupFinalizes } from "./DirectResourceCleanupRecovery.finalize.ts";

function candidate(operationId: string) {
  const command = {
    type: "thread.delete.finalize" as const,
    commandId: CommandId.makeUnsafe(`finalize-${operationId}`),
    threadId: ThreadId.makeUnsafe(`thread-${operationId}`),
    threadIds: [ThreadId.makeUnsafe(`thread-${operationId}`)],
    mode: "single" as const,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
  const digest = calculateCommandPayloadDigest(command);
  return {
    operationId,
    createdAt: "2026-08-30T00:00:00.000Z",
    finalizeCommandId: command.commandId,
    finalizePayloadJson: JSON.stringify(command),
    finalizePayloadDigestVersion: digest.version,
    finalizePayloadDigest: digest.digest,
  };
}

function executorService() {
  return {
    prepare: () =>
      Effect.succeed({
        assertAlive: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
        close: vi.fn(),
      } as never),
  } as never;
}

describe("prepared cleanup finalize recovery", () => {
  it("retries a transient dispatch failure on the next pass", async () => {
    const stored = candidate("retry");
    const dispatch = vi
      .fn()
      .mockReturnValueOnce(Effect.fail(new Error("transient")))
      .mockReturnValueOnce(Effect.succeed({ sequence: 1 }));
    const blockPrepared = vi.fn(() => Effect.succeed(true));
    const repository = {
      listPreparedFinalizeCandidates: () => Effect.succeed([stored]),
      blockPrepared,
    } as never;
    const input = {
      repository,
      executorService: executorService(),
      orchestration: { dispatch } as never,
    };
    await Effect.runPromise(recoverPreparedCleanupFinalizes(input));
    await Effect.runPromise(recoverPreparedCleanupFinalizes(input));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(blockPrepared).not.toHaveBeenCalled();
  });

  it("blocks an invalid first candidate and still dispatches the second", async () => {
    const invalid = { ...candidate("invalid"), finalizePayloadDigest: "bad" };
    const valid = candidate("valid");
    const dispatch = vi.fn(() => Effect.succeed({ sequence: 1 }));
    const blockPrepared = vi.fn(() => Effect.succeed(true));
    await Effect.runPromise(
      recoverPreparedCleanupFinalizes({
        repository: {
          listPreparedFinalizeCandidates: () => Effect.succeed([invalid, valid]),
          blockPrepared,
        } as never,
        executorService: executorService(),
        orchestration: { dispatch } as never,
      }),
    );
    expect(blockPrepared).toHaveBeenCalledWith(
      invalid.operationId,
      "invalid_finalize_payload",
      expect.any(String),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps duplicate redispatch idempotent through the immutable command id", async () => {
    const stored = candidate("duplicate");
    const accepted = new Set<string>();
    const dispatch = vi.fn((command: { readonly commandId: string }) =>
      Effect.sync(() => {
        accepted.add(command.commandId);
        return { sequence: 1 };
      }),
    );
    const input = {
      repository: {
        listPreparedFinalizeCandidates: () => Effect.succeed([stored]),
        blockPrepared: () => Effect.succeed(true),
      } as never,
      executorService: executorService(),
      orchestration: { dispatch } as never,
    };
    await Effect.runPromise(recoverPreparedCleanupFinalizes(input));
    await Effect.runPromise(recoverPreparedCleanupFinalizes(input));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(accepted).toEqual(new Set([stored.finalizeCommandId]));
  });
});
