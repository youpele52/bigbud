import { createHash } from "node:crypto";
import { Effect } from "effect";
import type { initializeDevSshGuardedWriteJournal } from "../persistence/Layers/DevSshGuardedWriteJournal.ts";
import type { PickerProofWorkspaceClient } from "./sshOwnerPickerProof.client.workspace.ts";
import type { GuardedWriteResult } from "./sshOwnerPickerProof.codec.guardedWrite.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";
import { MAX_GUARDED_WRITE_BYTES } from "./sshOwnerPickerProof.guardedWriteStage.ts";

type Journal = Effect.Success<ReturnType<typeof initializeDevSshGuardedWriteJournal>>;
const unknown = { kind: "unknown" } as const;

/** Private proof only. The app must supply an exact selected scope and a qualified owner. */
export async function applyGuardedWriteWithJournal(
  journal: Journal,
  owner: Pick<PickerProofWorkspaceClient, "applyProofGuardedWrite">,
  input: {
    readonly profileId: string;
    readonly targetId: string;
    readonly cwd: string;
    readonly relativePath: string;
    readonly operationId: string;
    readonly baseSha256: string;
    readonly contents: Uint8Array;
  },
  signal?: AbortSignal,
): Promise<GuardedWriteResult> {
  signal?.throwIfAborted();
  if (
    input.contents.byteLength > MAX_GUARDED_WRITE_BYTES ||
    !/^[a-f0-9]{64}$/.test(input.baseSha256)
  )
    throw new PickerProofOwnerError("invalidOperands");
  const { contents: source, ...request } = input;
  const contents = Uint8Array.from(source);
  const attemptedSha256 = createHash("sha256").update(contents).digest("hex");
  const binding = { ...request, attemptedSha256, byteSize: contents.byteLength };
  const previous = await Effect.runPromise(journal.lookup(binding));
  if (previous.kind === "existing") return previous.receipt ?? unknown;
  if (previous.kind !== "missing") throw new PickerProofOwnerError("operationDenied");
  const nativeId = createHash("sha256")
    .update(JSON.stringify([binding.profileId, binding.targetId, binding.operationId]))
    .digest("hex")
    .slice(0, 32);

  let claimed = false;
  let concurrentReceipt: GuardedWriteResult | undefined;
  let result: GuardedWriteResult;
  try {
    result = await owner.applyProofGuardedWrite(
      {
        executionTargetId: binding.targetId,
        workspaceRoot: binding.cwd,
        relativePath: binding.relativePath,
        operationId: nativeId,
        expectedSha256: Buffer.from(binding.baseSha256, "hex"),
        contents,
      },
      async (draft) => {
        if (
          draft.operationId !== nativeId ||
          draft.workspaceRoot !== binding.cwd ||
          draft.relativePath !== binding.relativePath ||
          draft.bodyBytes !== binding.byteSize ||
          Buffer.from(draft.expectedSha256).toString("hex") !== binding.baseSha256 ||
          Buffer.from(draft.attemptedSha256).toString("hex") !== binding.attemptedSha256
        )
          throw new PickerProofOwnerError("operationDenied");
        signal?.throwIfAborted();
        const claim = await Effect.runPromise(journal.claim(binding));
        if (claim.kind === "existing") concurrentReceipt = claim.receipt ?? unknown;
        if (claim.kind !== "claimed") throw new PickerProofOwnerError("operationDenied");
        claimed = true;
      },
      signal,
    );
  } catch (error) {
    if (!claimed) {
      if (concurrentReceipt) return concurrentReceipt;
      throw error;
    }
    result = unknown;
  }
  if (!claimed) throw new PickerProofOwnerError("operationDenied");
  if (result.kind === "saved" && result.resultSha256 !== binding.attemptedSha256) result = unknown;
  try {
    const settlement = await Effect.runPromise(journal.recordReceipt(binding, result));
    return settlement.kind === "recorded" ? result : unknown;
  } catch {
    // The claim is still non-replayable; the observed outcome was not durably settled.
    return unknown;
  }
}
