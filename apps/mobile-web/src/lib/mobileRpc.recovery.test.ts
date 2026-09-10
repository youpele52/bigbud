import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";
import { MobileRpcClient } from "./mobileRpc";
import { MobileRecoveryUnsupportedError } from "./mobileRpc.errors";

function makeClient(protocol: Record<string, unknown>) {
  return new MobileRpcClient("ws://fixture", undefined, {
    clientPromise: Promise.resolve(protocol as never),
    runtime: {
      runCallback: Effect.runCallback,
      runSync: () => ({}),
      runPromise: async () => undefined,
      dispose: () => undefined,
    } as never,
  });
}

describe("mobile RPC recovery boundary", () => {
  it("normalizes real Effect failures for baseline and stream at the client boundary", async () => {
    const client = makeClient({
      "mobile.recovery.getBaseline": () =>
        Effect.die("Unknown request tag: mobile.recovery.getBaseline"),
      "mobile.recovery.subscribe": () =>
        Stream.die("Unknown request tag: mobile.recovery.subscribe"),
    });
    await expect(
      client.getMobileRecoveryBaseline({ recoveryAttemptId: "attempt" }),
    ).rejects.toBeInstanceOf(MobileRecoveryUnsupportedError);
    const onError = vi.fn();
    await new Promise<void>((resolve) =>
      client.startMobileRecoveryStream({
        recoveryAttemptId: "attempt",
        serverEpoch: "epoch",
        baselineSequence: 0,
        dispatchFrame: vi.fn(),
        onError,
        onExit: resolve,
      }),
    );
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(MobileRecoveryUnsupportedError);
    await client.dispose();
  });

  it("propagates abort to the underlying legacy RPC fiber", async () => {
    const finalized = vi.fn();
    const client = makeClient({
      "orchestration.getSnapshot": () => Effect.never.pipe(Effect.ensuring(Effect.sync(finalized))),
    });
    const abort = new AbortController();
    const promise = client.getSnapshot(abort.signal);
    await Promise.resolve();
    await Promise.resolve();
    abort.abort();
    await expect(promise).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(finalized).toHaveBeenCalledOnce());
    await client.dispose();
  });
});
