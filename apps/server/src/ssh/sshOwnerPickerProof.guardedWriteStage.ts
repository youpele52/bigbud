import { createHash } from "node:crypto";
import type {
  GuardedWriteBinding,
  GuardedWriteOperation,
  GuardedWriteStage,
} from "./sshOwnerPickerProof.codec.guardedWrite.ts";
import { invalid, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { MAX_WORKSPACE_WRITE_BYTES } from "./sshOwnerPickerProof.codec.workspace.ts";

export const MAX_GUARDED_WRITE_BYTES = 512 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Private fixture staging. A resolved result is explicitly not a save receipt. */
export async function prepareGuardedWriteForProof(
  execute: (operation: GuardedWriteOperation) => Promise<GuardedWriteStage>,
  input: Omit<GuardedWriteBinding, "attemptedSha256" | "bodyBytes"> & {
    readonly contents: Uint8Array;
  },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (input.contents.byteLength > MAX_GUARDED_WRITE_BYTES || input.contents.includes(0))
    throw new PickerProofOwnerError("invalidOperands");
  const contents = Uint8Array.from(input.contents);
  try {
    textDecoder.decode(contents);
  } catch {
    throw new PickerProofOwnerError("invalidOperands");
  }
  const binding: GuardedWriteBinding = {
    operationId: input.operationId,
    workspaceRoot: input.workspaceRoot,
    relativePath: input.relativePath,
    expectedSha256: Uint8Array.from(input.expectedSha256),
    attemptedSha256: createHash("sha256").update(contents).digest(),
    bodyBytes: contents.byteLength,
  };
  const begun = await execute({ kind: "proofGuardedWriteBegin", binding });
  if (begun.state !== "begun") return invalid();
  const { lease } = begun;
  try {
    for (let offset = 0; offset < contents.byteLength; offset += MAX_WORKSPACE_WRITE_BYTES) {
      signal?.throwIfAborted();
      const data = contents.subarray(offset, offset + MAX_WORKSPACE_WRITE_BYTES);
      const reply = await execute({ kind: "proofGuardedWriteChunk", binding, lease, offset, data });
      if (reply.state !== "chunkAccepted" || reply.nextOffset !== offset + data.byteLength)
        return invalid();
    }
    signal?.throwIfAborted();
  } catch (error) {
    // Best-effort release of exactly this private draft. It cannot publish bytes.
    await execute({ kind: "proofGuardedWriteAbort", binding, lease }).catch(() => undefined);
    throw error;
  }
  return { binding, lease };
}

export async function validateGuardedWriteForProof(
  execute: Parameters<typeof prepareGuardedWriteForProof>[0],
  input: Parameters<typeof prepareGuardedWriteForProof>[1],
  signal?: AbortSignal,
): Promise<{ readonly state: "validatedNotDispatched" }> {
  const { binding, lease } = await prepareGuardedWriteForProof(execute, input, signal);
  // Never retry or send Abort after committing, including on an unconfirmed reply.
  const committed = await execute({ kind: "proofGuardedWriteCommit", binding, lease });
  if (committed.state !== "validatedNotDispatched") return invalid();
  return { state: "validatedNotDispatched" };
}
