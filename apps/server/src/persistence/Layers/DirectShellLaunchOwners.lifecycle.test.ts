import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { fixture, owner } from "./DirectShellLaunchOwners.test.helpers";
import { makeDirectShellLaunchOwners } from "./DirectShellLaunchOwners";
import {
  directShellLaunchDigest,
  parseDirectShellLaunchOwner,
  type DirectShellLaunchOwner,
} from "../../terminal/Layers/DirectShellLaunch.owner";
import { makeDirectShellLaunchDispatcher } from "../../terminal/Layers/DirectShellLaunch.dispatch";

// Simulated authenticated host control, not a native helper or platform qualification.
const binding = {
  version: 1 as const,
  executable: "/home/tester/.bigbud/direct-helper/v1/bin/helper",
  sha256: "1".repeat(64),
  statePath: "/home/tester/.bigbud/direct-helper/state",
  epoch: "helper-epoch",
};
function boundOwner() {
  const saved = owner();
  const intent = { ...saved.intent, lifecycle: binding };
  return { ...saved, intent, digest: directShellLaunchDigest(intent) };
}
function receipt(saved: DirectShellLaunchOwner) {
  return {
    version: 1,
    ownerKey: saved.ownerKey,
    reservationId: saved.reservationId,
    controllerId: saved.controllerId,
    digest: saved.digest,
    epoch: binding.epoch,
    state: "terminated",
    childReaped: true,
    ptyReleased: true,
    cleanupComplete: true,
    admissionClosed: true,
  };
}
async function dispatched() {
  const f = await fixture();
  const saved = boundOwner();
  await f.store.reserve(saved);
  await f.store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId);
  const current = (await f.store.get(saved.ownerKey))!;
  return { ...f, saved: current };
}

it("keeps old digest bytes and binds every helper identity field only in the new digest form", () => {
  const saved = owner();
  const launch = saved.intent.launch;
  const legacyDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        executionTargetId: saved.intent.executionTargetId,
        wslIdentity: null,
        cwd: launch.cwd,
        host: launch.requestedProfile.host,
        profileId: launch.requestedProfile.profileId,
        kind: launch.requestedProfile.kind,
        executable: launch.executable,
        args: launch.args,
        platform: launch.platform,
        integration: launch.integration,
      }),
    )
    .digest("hex");
  expect(saved.digest).toBe(legacyDigest);
  const bound = boundOwner();
  expect(bound.digest).not.toBe(legacyDigest);
  for (const [field, value] of Object.entries({
    executable: "/other/helper",
    sha256: "2".repeat(64),
    statePath: "/other/state",
    epoch: "other-epoch",
  })) {
    const changed = { ...bound.intent, lifecycle: { ...binding, [field]: value } };
    expect(directShellLaunchDigest(changed)).not.toBe(bound.digest);
    expect(() => parseDirectShellLaunchOwner({ ...bound, intent: changed })).toThrow("digest");
  }
});

it("does not consult host control for legacy, prepared, absent or stale owner confirmations", async () => {
  const { store } = await fixture();
  const closeAndVerify = vi.fn(async () => "");
  const legacy = owner();
  await store.reserve(legacy);
  expect(await store.confirmTerminated(legacy, { closeAndVerify })).toBe(false);
  await store.claimDispatch(legacy.ownerKey, legacy.reservationId, legacy.controllerId);
  expect(
    await store.confirmTerminated((await store.get(legacy.ownerKey))!, { closeAndVerify }),
  ).toBe(false);
  await store.cancelPrepared(legacy.ownerKey, legacy.reservationId, legacy.controllerId);
  expect(await store.confirmTerminated(boundOwner(), { closeAndVerify })).toBe(false);
  expect(closeAndVerify).not.toHaveBeenCalled();
  expect(await store.get(legacy.ownerKey)).toBeDefined();
});

it("never calls host control for a bound prepared reservation, missing row, or stale snapshot", async () => {
  const { store } = await fixture();
  const saved = boundOwner();
  const closeAndVerify = vi.fn(async () => "");
  await store.reserve(saved);
  expect(await store.confirmTerminated(saved, { closeAndVerify })).toBe(false);
  const dispatched = { ...saved, state: "may-have-been-sent" as const };
  expect(await store.confirmTerminated(dispatched, { closeAndVerify })).toBe(false);
  await store.cancelPrepared(saved.ownerKey, saved.reservationId, saved.controllerId);
  expect(await store.confirmTerminated(dispatched, { closeAndVerify })).toBe(false);
  expect(closeAndVerify).not.toHaveBeenCalled();
});

it.each(["relative/helper", "/", "/a/../helper", "/helper\n", "/helper\u0000"])(
  "rejects unsafe helper paths before reservation %#",
  (path) => {
    const saved = boundOwner();
    for (const key of ["executable", "statePath"]) {
      expect(() =>
        directShellLaunchDigest({
          ...saved.intent,
          lifecycle: { ...binding, [key]: path },
        }),
      ).toThrow();
    }
  },
);

it("removes only a matched dispatched helper-bound owner after a definitive private receipt", async () => {
  const { store, saved } = await dispatched();
  const closeAndVerify = vi.fn(async (input: DirectShellLaunchOwner) =>
    JSON.stringify(receipt(input)),
  );
  expect(await store.confirmTerminated(saved, { closeAndVerify })).toBe(true);
  expect(closeAndVerify).toHaveBeenCalledExactlyOnceWith(saved);
  expect(await store.get(saved.ownerKey)).toBeUndefined();
  expect(await store.confirmTerminated(saved, { closeAndVerify })).toBe(false);
  expect(closeAndVerify).toHaveBeenCalledTimes(1);
  const next = owner("next", "next-controller");
  await store.reserve(next);
  expect(await store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId)).toBe(
    false,
  );
  expect(await store.confirmTerminated(saved, { closeAndVerify })).toBe(false);
  expect(await store.get(saved.ownerKey)).toEqual(next);
});

it.each([
  ["ownerKey", "terminal:other"],
  ["reservationId", "other"],
  ["controllerId", "other"],
  ["digest", "0".repeat(64)],
  ["epoch", "other"],
  ["version", 2],
  ["state", "missing"],
  ["childReaped", false],
  ["ptyReleased", false],
  ["cleanupComplete", false],
  ["admissionClosed", false],
  ["extra", "unrecognized"],
])("retains ownership on unmatched or incomplete receipt %s", async (field, value) => {
  const { store, saved } = await dispatched();
  await expect(
    store.confirmTerminated(saved, {
      closeAndVerify: async () => JSON.stringify({ ...receipt(saved), [field]: value }),
    }),
  ).rejects.toThrow();
  expect(await store.get(saved.ownerKey)).toEqual(saved);
});

it.each(["", "EOF", "{", " ".repeat(4097)])(
  "retains ownership on malformed/bounded control failure %#",
  async (frame) => {
    const { store, saved } = await dispatched();
    await expect(
      store.confirmTerminated(saved, { closeAndVerify: async () => frame }),
    ).rejects.toThrow();
    expect(await store.get(saved.ownerKey)).toEqual(saved);
  },
);

it("retains the owner on control error and database failure even after a valid receipt", async () => {
  const { runtime, store, sql, saved } = await dispatched();
  await expect(
    store.confirmTerminated(saved, {
      closeAndVerify: async () => {
        throw new Error("lost control");
      },
    }),
  ).rejects.toThrow("lost control");
  await runtime.runPromise(sql`PRAGMA query_only = ON`);
  await expect(
    store.confirmTerminated(saved, {
      closeAndVerify: async () => JSON.stringify(receipt(saved)),
    }),
  ).rejects.toThrow();
  expect(await store.get(saved.ownerKey)).toEqual(saved);
});

it("fences a state change during host cleanup and can explicitly reconcile after database reopen", async () => {
  const f = await dispatched();
  let resolve!: (frame: string) => void;
  const closeAndVerify = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const pending = f.store.confirmTerminated(f.saved, { closeAndVerify });
  await vi.waitFor(() => expect(closeAndVerify).toHaveBeenCalledOnce());
  await f.store.markUnknown(f.saved.ownerKey, f.saved.reservationId, f.saved.controllerId);
  resolve(JSON.stringify(receipt(f.saved)));
  expect(await pending).toBe(false);
  await f.runtime.dispose();
  const reopened = await f.open();
  const store = await reopened.runPromise(makeDirectShellLaunchOwners());
  const unknown = (await store.get(f.saved.ownerKey))!;
  expect(unknown.state).toBe("outcome-unknown");
  expect(
    await store.confirmTerminated(unknown, {
      closeAndVerify: async () => JSON.stringify(receipt(unknown)),
    }),
  ).toBe(true);
  expect(await store.get(f.saved.ownerKey)).toBeUndefined();
});

it("grants at most one removal across independent controllers verifying the same closed admission", async () => {
  const f = await dispatched();
  const otherRuntime = await f.open();
  const other = await otherRuntime.runPromise(makeDirectShellLaunchOwners());
  const control = { closeAndVerify: async () => JSON.stringify(receipt(f.saved)) };
  const results = await Promise.all([
    f.store.confirmTerminated(f.saved, control),
    other.confirmTerminated(f.saved, control),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await f.store.get(f.saved.ownerKey)).toBeUndefined();
});

it("detaches caller and control-owned objects before asynchronous verification", async () => {
  const { store, saved } = await dispatched();
  const caller = structuredClone(saved);
  const pending = store.confirmTerminated(caller, {
    closeAndVerify: async (input) => {
      expect(input).toEqual(saved);
      (input.intent.launch.args as string[]).push("control-mutation");
      return JSON.stringify(receipt(saved));
    },
  });
  (caller.intent.launch.args as string[]).push("caller-mutation");
  expect(await pending).toBe(true);
  expect(saved.intent.launch.args).toEqual(["-o", "nopromptsp"]);
});

it("rejects helper-backed intent before reservation on the current unqualified direct dispatcher", async () => {
  const { store } = await fixture();
  const reserve = vi.spyOn(store, "reserve");
  const transport = vi.fn(async () => {});
  const dispatch = makeDirectShellLaunchDispatcher({ store, transport });
  await expect(
    dispatch({ threadId: "thread", terminalId: "pane", intent: boundOwner().intent }),
  ).rejects.toThrow("not yet available");
  expect(reserve).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
