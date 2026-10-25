import { expect, it, vi } from "vitest";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";
import { shouldPollV2Runtime } from "./Runtime.settlement.ts";
import { hasV2UnconfirmedFamily } from "./Runtime.family.loss.ts";

it("publishes authoritative cardless spawn/recovery ownership without inventing root execution", async () => {
  await withV2OwnedFamily(async ({ runtime, owner, events, http, expectRetainedClose }) => {
    await owner.family!.reserveSpawn("native-create-unconfirmed");
    expect(owner.family!.children).toHaveLength(0);
    expect(shouldPollV2Runtime(owner)).toBe(true);
    await runtime.reconcile(owner);
    expect(owner.session.status).toBe("ready");
    expect(owner.session.retainedFamily).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session.state.changed" &&
          event.payload.state === "ready" &&
          event.payload.retainedFamily === true,
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "task.updated")).toBe(false);
    await owner.family!.fence();
    await runtime.reconcile(owner);
    expect(owner.session.retainedFamily).toBe(true);
    expect(owner.family!.pendingSpawnCount).toBe(1);
    // A cached-zero journal drain is not the exact stopped/settled native barrier, so
    // host loss still retains ownership with no cards and a previously false flag.
    await owner.family!.confirmNativeDrain();
    owner.session = { ...owner.session, retainedFamily: false };
    http.die();
    await runtime.reconcile(owner);
    expect(owner.familyPhysicalDrain?.confirmed() ?? false).toBe(false);
    expect(hasV2UnconfirmedFamily(owner)).toBe(true);
    await vi.waitFor(() =>
      expect(owner.session).toMatchObject({ status: "error", retainedFamily: true }),
    );
    expectRetainedClose("server exit is not retained family shell termination");
  });
});
