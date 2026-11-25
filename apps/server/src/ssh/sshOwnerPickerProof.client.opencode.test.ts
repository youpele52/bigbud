import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { expect, it, vi } from "vitest";

import { makeProofOpencodeOwner } from "./sshOwnerPickerProof.client.opencode.ts";
import type {
  ProofOpencodeOperation,
  ProofOpencodeState,
} from "./sshOwnerPickerProof.codec.opencode.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

const fixture = {
  binaryPath: "/fixture/bin/opencode",
  cwd: "/fixture/work",
  threadId: ThreadId.makeUnsafe("fixture-thread"),
  sessionEpoch: 4,
  sha256: "a".repeat(64),
};
const request = { ...fixture, provider: "opencode", executionTargetId: "ssh:fixture" } as const;
const binding = () => ({
  ownerEpoch: new Uint8Array(32).fill(1),
  targetGeneration: new Uint8Array(32).fill(2),
});

type Execute = (op: ProofOpencodeOperation, dispatch?: () => void) => Promise<ProofOpencodeState>;

it("cancels before dispatch without submitting a close or a late open", async () => {
  const grant = Promise.withResolvers<void>();
  const execute = vi.fn<Execute>(async (op, dispatch) => {
    await grant.promise;
    dispatch?.();
    return { phase: "starting", lease: op.lease };
  });
  const owner = makeProofOpencodeOwner(
    request.executionTargetId,
    fixture,
    undefined,
    binding,
    execute,
  );
  const start = owner.startProvider(request);
  const close = start.cancel();
  grant.resolve();
  await expect(close).resolves.toBeUndefined();
  await expect(start.ready).rejects.toMatchObject({ code: "operationDenied" });
  expect(execute.mock.calls.map(([op]) => op.kind)).toEqual(["proofOpencodeOpen"]);
});

it("waits for teardown rather than acknowledging a pending close", async () => {
  const cleanup = Promise.withResolvers<void>();
  const execute = vi.fn<Execute>(async (op, dispatch) => {
    dispatch?.();
    if (op.kind === "proofOpencodeOpen")
      return { phase: "ready", localPort: 43210, lease: op.lease };
    if (op.kind === "proofOpencodeClose") return { phase: "closing", lease: op.lease };
    // A regular status poll can get ahead of explicit cancellation, so only block after Close.
    if (execute.mock.calls.some(([call]) => call.kind === "proofOpencodeClose")) {
      await cleanup.promise;
      return { phase: "closed", lease: op.lease };
    }
    return { phase: "ready", localPort: 43210, lease: op.lease };
  });
  const owner = makeProofOpencodeOwner(
    request.executionTargetId,
    fixture,
    undefined,
    binding,
    execute,
  );
  const start = owner.startProvider(request);
  await expect(start.ready).resolves.toEqual({ localPort: 43210 });
  const close = start.cancel();
  const completed = vi.fn();
  void close.then(completed);
  await vi.waitFor(() =>
    expect(execute.mock.calls.some(([call]) => call.kind === "proofOpencodeClose")).toBe(true),
  );
  expect(completed).not.toHaveBeenCalled();
  cleanup.resolve();
  await expect(close).resolves.toBeUndefined();
  expect(execute.mock.calls.filter(([call]) => call.kind === "proofOpencodeClose")).toHaveLength(1);
});

it("reports lost post-dispatch replies as teardown unconfirmed", async () => {
  const execute = vi.fn<Execute>(async (_op, dispatch) => {
    dispatch?.();
    throw new PickerProofOwnerError("ownerUnavailable");
  });
  const owner = makeProofOpencodeOwner(
    request.executionTargetId,
    fixture,
    undefined,
    binding,
    execute,
  );
  const start = owner.startProvider(request);
  await expect(start.ready).rejects.toMatchObject({ code: "ownerUnavailable" });
  await expect(start.cancel()).rejects.toMatchObject({ code: "ownerUnavailable" });
  expect(execute).toHaveBeenCalledTimes(1);
});
