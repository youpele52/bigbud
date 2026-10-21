import { expect, it } from "vitest";
import { withV2OwnedFamily } from "./Runtime.family.fixture.ts";
import { shouldPollV2Runtime } from "./Runtime.settlement.ts";

it("publishes authoritative cardless spawn/recovery ownership without inventing root execution", async () => {
  await withV2OwnedFamily(async ({ runtime, owner, events, http }) => {
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
    // Explicit scripted physical drain proof retires the fixture's obligation;
    // server death alone must never clear it.
    await owner.family!.confirmNativeDrain();
    owner.session = { ...owner.session, retainedFamily: false };
    http.die();
    await runtime.reconcile(owner);
  });
});
