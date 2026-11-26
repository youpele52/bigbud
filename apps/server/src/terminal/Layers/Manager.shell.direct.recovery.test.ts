import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { assertDirectShellLaunchAvailable } from "./Manager.shell.direct";
import {
  fixture,
  ownerKey,
  pane,
  prepared,
  request,
} from "./DirectShellLaunch.dispatch.test.helpers";

const input = {
  ...pane,
  executionTargetId: request().intent.executionTargetId,
  recoverPrepared: true,
};
function harness() {
  const f = fixture();
  vi.mocked(f.store.cancelPrepared).mockImplementation(async (key, reservation, controller) => {
    const owner = f.entries.get(key);
    if (
      owner?.state !== "prepared" ||
      owner.reservationId !== reservation ||
      owner.controllerId !== controller
    )
      return false;
    return f.entries.delete(key);
  });
  return f;
}

describe("explicit direct launch reservation recovery", () => {
  it("a dispatch claim winning the race retains ownership and refuses replacement", async () => {
    const f = harness();
    f.entries.set(ownerKey, prepared());
    const get = vi.mocked(f.store.get).getMockImplementation()!;
    vi.mocked(f.store.get).mockImplementation(async (key) => {
      const snapshot = await get(key);
      const owner = f.entries.get(key)!;
      await f.store.claimDispatch(key, owner.reservationId, owner.controllerId);
      return snapshot;
    });
    const result = await Effect.runPromise(
      assertDirectShellLaunchAvailable(f.store, input).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(f.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(["may-have-been-sent", "outcome-unknown"] as const)(
    "never attempts to cancel %s ownership",
    async (state) => {
      const f = harness();
      f.entries.set(ownerKey, prepared(state));
      const result = await Effect.runPromise(
        assertDirectShellLaunchAvailable(f.store, input).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("may still be running");
      expect(f.store.cancelPrepared).not.toHaveBeenCalled();
      expect(f.entries.get(ownerKey)?.state).toBe(state);
    },
  );

  it("cancellation uncertainty refuses replacement without attempting transport", async () => {
    const f = harness();
    f.entries.set(ownerKey, prepared());
    vi.mocked(f.store.cancelPrepared).mockRejectedValue(new Error("database unavailable"));
    const result = await Effect.runPromise(
      assertDirectShellLaunchAvailable(f.store, input).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    expect(f.entries.get(ownerKey)?.state).toBe("prepared");
    expect(f.transport).not.toHaveBeenCalled();
  });
});
