import { realpath } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withV2SettlementFixture } from "./Runtime.settlement.fixture.ts";
import { V2OwnedFamily } from "./Subagents.ownership.ts";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import { deferred } from "./Test.fixtures.ts";

it("a completed sibling closes independently while live background/nested work keeps the actual reservation", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send, setActive, gate }) => {
    owner.family = await V2OwnedFamily.open(
      await realpath(path.dirname(owner.native.location.directory)),
      { rootId: owner.native.id, threadId: owner.threadId, storageIdentity: owner.storageIdentity },
    );
    await send("mixed-sibling-reservation");
    const token = owner.activation!.token;
    for (const [id, parent] of [
      ["ses_done", owner.native.id],
      ["ses_background", owner.native.id],
      ["ses_nested", "ses_background"],
    ]) {
      http.sessions.set(id!, {
        ...owner.native,
        id: id!,
        parentID: parent!,
        outcome: "succeeded",
        time: { created: 1, updated: 5, idle: 6 },
      });
      await owner.family.enroll({
        id: id!,
        parentId: parent!,
        agent: "explore",
        description: "scripted",
        prompt: "scripted",
        messageId: `msg_${id}`,
        callId: `call_${id}`,
        background: id !== "ses_done",
        nativeRevision: 2,
      });
    }
    owner.familyControl = {
      busyCount: () => 2,
      childBusyCount: (id) => (id === "ses_done" ? 0 : 1),
      fence: async () => {},
      authorizeInput: async () => {},
    };
    setActive(false);
    try {
      expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-callbacks");
      expect(owner.family.child("ses_done")?.state).toBe("terminal");
      expect(owner.family.child("ses_background")?.state).toBe("enrolled");
      expect(owner.family.child("ses_nested")?.state).toBe("enrolled");
      expect(owner.activation!.token).toBe(token);
      expect(gate.busyCount()).toBe(1);
    } finally {
      delete owner.familyControl;
    }
  });
});

it("direct root-idle settlement retains exclusion for child work, durable spawn gaps, callbacks and continuation obligations", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send, setActive, gate }) => {
    owner.family = await V2OwnedFamily.open(
      await realpath(path.dirname(owner.native.location.directory)),
      { rootId: owner.native.id, threadId: owner.threadId, storageIdentity: owner.storageIdentity },
    );
    await send("family-settlement");
    const token = owner.activation!.token;
    http.sessions.set("ses_live", {
      ...owner.native,
      id: "ses_live",
      parentID: owner.native.id,
      time: { created: 1, updated: 2 },
    });
    await owner.family.enroll({
      id: "ses_live",
      parentId: owner.native.id,
      agent: "explore",
      description: "Offline child",
      prompt: "offline",
      messageId: "msg_spawn",
      callId: "call_spawn",
      background: false,
      nativeRevision: 2,
    });
    setActive(false);
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-live");
    expect(owner.activation!.token).toBe(token);
    http.sessions.set("ses_live", {
      ...http.sessions.get("ses_live")!,
      outcome: "succeeded",
      time: { created: 1, updated: 5, idle: 6 },
    });
    let callbacks = 1;
    let nativeJobPending = 0;
    owner.familyControl = {
      busyCount: () => callbacks + nativeJobPending,
      childBusyCount: () => nativeJobPending,
      fence: async () => {},
      authorizeInput: async () => {},
    };
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-callbacks");
    const writing = deferred<void>(),
      release = deferred<void>();
    const reserve = owner.family.reserveSpawn.bind(owner.family);
    const spy = vi.spyOn(owner.family, "reserveSpawn").mockImplementation(async (key) => {
      writing.resolve();
      await release.promise;
      return reserve(key);
    });
    const reserving = owner.family.reserveSpawn("offline-spawn-receipt");
    await writing.promise;
    try {
      // Production counts the callback until reserveSpawn commits. Force repair
      // inside that write gap instead of depending on the 100ms poll timer.
      runtime.scheduleRepair(owner, false);
      await runtime.withSession(owner.threadId, async () => {});
      expect(owner.family.pendingSpawnCount).toBe(0);
      expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-callbacks");
      expect(owner.activation!.token).toBe(token);
    } finally {
      release.resolve();
      await reserving;
      spy.mockRestore();
    }
    callbacks = 0;
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-live");
    expect(gate.busyCount()).toBe(1);
    // A background obligation cannot be discharged by model idle alone.
    await owner.family.enroll({ ...owner.family.child("ses_live")!, background: true });
    await owner.family.execution("ses_live", "offline-spawn-receipt", "started");
    await owner.family.completeSpawn("offline-spawn-receipt");
    expect(owner.family.child("ses_live")?.executionPending).toBe(true);
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-live");
    await owner.family.execution("ses_live", "offline-spawn-receipt", "running");
    expect(owner.family.child("ses_live")?.continuationPending).toBe(true);
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-live");
    nativeJobPending = 1;
    await owner.family.nativeCompletion("ses_live", "msg_native_completion");
    expect(await settleV2RuntimeReservation(runtime, owner)).toBe("family-callbacks");
    expect(owner.family.child("ses_live")?.state).toBe("enrolled");
    expect(gate.busyCount()).toBe(1);
    nativeJobPending = 0;
    expect(await settleV2RuntimeReservation(runtime, owner)).toBeUndefined();
    expect(owner.family.child("ses_live")?.state).toBe("terminal");
    expect(owner.activation!.token).toBeUndefined();
    expect(gate.busyCount()).toBe(0);
    delete owner.familyControl;
  });
});

it("a callback entering during awaited direct drain keeps the activation reservation", async () => {
  await withV2SettlementFixture(async ({ runtime, owner, http, send, setActive }) => {
    await send("late-callback");
    setActive(false);
    const reading = deferred<void>(),
      release = deferred<void>();
    const spy = vi.spyOn(http.client.session, "active").mockImplementation(async () => {
      reading.resolve();
      await release.promise;
      return {};
    });
    const operation = settleV2RuntimeReservation(runtime, owner);
    await reading.promise;
    owner.familyControl = {
      busyCount: () => 1,
      fence: async () => {},
      authorizeInput: async () => {},
    };
    release.resolve();
    try {
      expect(await operation).toBe("family-callbacks");
      expect(owner.activation!.token).toBeDefined();
    } finally {
      spy.mockRestore();
      delete owner.familyControl;
    }
    expect(await settleV2RuntimeReservation(runtime, owner)).toBeUndefined();
  });
});
