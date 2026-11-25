import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type {
  GuardedWriteOperation,
  GuardedWriteStage,
} from "./sshOwnerPickerProof.codec.guardedWrite.ts";
import {
  MAX_GUARDED_WRITE_BYTES,
  validateGuardedWriteForProof,
} from "./sshOwnerPickerProof.guardedWriteStage.ts";

const input = {
  operationId: "0123456789abcdef0123456789abcdef",
  workspaceRoot: "/disposable/workspace",
  relativePath: "a.txt",
  expectedSha256: new Uint8Array(32).fill(2),
  contents: new Uint8Array(MAX_GUARDED_WRITE_BYTES).fill(65),
};
const lease = new Uint8Array(40).fill(1);

it("stages the complete verified payload across bounded offsets without a save receipt", async () => {
  const expected = createHash("sha256").update(input.contents).digest();
  const source = { ...input, contents: Uint8Array.from(input.contents) };
  let bytes = 0;
  const execute = vi.fn(async (operation: GuardedWriteOperation): Promise<GuardedWriteStage> => {
    expect(operation.binding.attemptedSha256).toEqual(expected);
    switch (operation.kind) {
      case "proofGuardedWriteBegin":
        source.contents.fill(66); // A consumer mutation cannot alter the staged bytes.
        return { state: "begun", lease };
      case "proofGuardedWriteChunk":
        expect(operation.lease).toEqual(lease);
        expect(operation.offset).toBe(bytes);
        expect(operation.data.length).toBeLessThanOrEqual(48 * 1024);
        expect(operation.data.every((byte) => byte === 65)).toBe(true);
        bytes += operation.data.byteLength;
        return { state: "chunkAccepted", nextOffset: bytes };
      case "proofGuardedWriteCommit":
        expect(bytes).toBe(input.contents.length);
        return { state: "validatedNotDispatched" };
      default:
        throw new Error("Unexpected abort");
    }
  });
  await expect(validateGuardedWriteForProof(execute, source)).resolves.toEqual({
    state: "validatedNotDispatched",
  });
  expect(execute).toHaveBeenCalledTimes(13); // begin + eleven chunks + commit
});

it("does not retry a lost commit reply or abort the potentially consumed lease", async () => {
  const failure = new Error("commit reply lost");
  const execute = vi.fn(async (operation: GuardedWriteOperation): Promise<GuardedWriteStage> => {
    switch (operation.kind) {
      case "proofGuardedWriteBegin":
        return { state: "begun", lease };
      case "proofGuardedWriteCommit":
        throw failure;
      default:
        throw new Error("Unexpected operation");
    }
  });
  await expect(
    validateGuardedWriteForProof(execute, { ...input, contents: new Uint8Array() }),
  ).rejects.toBe(failure);
  expect(execute.mock.calls.map(([operation]) => operation.kind)).toEqual([
    "proofGuardedWriteBegin",
    "proofGuardedWriteCommit",
  ]);
});

it("aborts only its own draft on a noncontiguous acknowledgement", async () => {
  const execute = vi.fn(async (operation: GuardedWriteOperation): Promise<GuardedWriteStage> => {
    switch (operation.kind) {
      case "proofGuardedWriteBegin":
        return { state: "begun", lease };
      case "proofGuardedWriteChunk":
        return { state: "chunkAccepted", nextOffset: 2 };
      case "proofGuardedWriteAbort":
        expect(operation.lease).toEqual(lease);
        return { state: "aborted" };
      default:
        throw new Error("Commit must not be attempted");
    }
  });
  await expect(
    validateGuardedWriteForProof(execute, { ...input, contents: Uint8Array.of(65) }),
  ).rejects.toMatchObject({ code: "protocolError" });
  expect(execute.mock.calls.map(([operation]) => operation.kind)).toEqual([
    "proofGuardedWriteBegin",
    "proofGuardedWriteChunk",
    "proofGuardedWriteAbort",
  ]);
});
