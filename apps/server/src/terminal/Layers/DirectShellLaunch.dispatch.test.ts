import { expect, it, vi } from "vitest";
import { parseDirectShellLaunchOwner } from "./DirectShellLaunch.owner";
import {
  deferred,
  fixture,
  ownerKey,
  pane,
  prepared,
  request,
} from "./DirectShellLaunch.dispatch.test.helpers";

it("reserves one winner across concurrent controllers before granting one transport call", async () => {
  const f = fixture();
  const claim = vi.mocked(f.store.claimDispatch).getMockImplementation()!;
  vi.mocked(f.store.claimDispatch).mockImplementation(async (...args) => {
    expect(f.entries.get(ownerKey)?.state).toBe("prepared");
    expect(f.transport).not.toHaveBeenCalled();
    return claim(...args);
  });
  const results = await Promise.all([
    f.controller("left")(request()),
    f.controller("right")(request()),
  ]);
  expect(results.map((r) => r.action).toSorted()).toEqual(["dispatched", "retained"]);
  expect(f.store.claimDispatch).toHaveBeenCalledTimes(1);
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.entries.get(ownerKey)?.state).toBe("may-have-been-sent");
  expect(f.store.cancelPrepared).not.toHaveBeenCalled();
});

it.each(["prepared", "may-have-been-sent", "outcome-unknown"] as const)(
  "retains a %s owner even with identical digest and dead controller, without a claim",
  async (state) => {
    const f = fixture();
    const existing = prepared(state);
    f.entries.set(ownerKey, existing);
    const output = await f.controller()(request());
    expect(output).toEqual({
      action: "retained",
      owner: existing,
      shellUnconfirmedLaunch: {
        status: "unconfirmed",
        requestedProfile: existing.intent.launch.requestedProfile,
      },
    });
    expect(f.store.claimDispatch).not.toHaveBeenCalled();
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.store.cancelPrepared).not.toHaveBeenCalled();
  },
);

it("blocks repeated requests and changed-intent fallback attempts, including after transport completion", async () => {
  const f = fixture();
  const dispatch = f.controller();
  const initial = await dispatch(request());
  expect(initial.action).toBe("dispatched");
  expect((await dispatch(request())).action).toBe("retained");
  const fallback = request();
  fallback.intent = { ...fallback.intent, launch: { ...fallback.intent.launch, cwd: "/other" } };
  const retained = await f.controller("restart")(fallback);
  expect(retained.action).toBe("retained");
  if (retained.action === "missing") throw new Error("Expected retained owner");
  expect(retained.owner.intent.launch.cwd).toBe(request().intent.launch.cwd);
  expect(f.store.claimDispatch).toHaveBeenCalledTimes(1);
  expect(f.transport).toHaveBeenCalledTimes(1);
  expect(f.store.cancelPrepared).not.toHaveBeenCalled();
});

it("recovery-only never reserves, claims, dispatches or reclaims a missing/dead owner", async () => {
  const f = fixture();
  const recover = { ...pane, recoverOnly: true as const };
  expect(await f.controller()(recover)).toEqual({ action: "missing" });
  for (const state of ["prepared", "may-have-been-sent", "outcome-unknown"] as const) {
    const saved = prepared(state);
    f.entries.set(ownerKey, saved);
    const result = await f.controller("replacement")(recover);
    expect(result).toMatchObject({ action: "retained", owner: saved });
  }
  expect(f.store.get).toHaveBeenCalledTimes(4);
  for (const operation of [
    f.store.reserve,
    f.store.claimDispatch,
    f.store.cancelPrepared,
    f.transport,
  ])
    expect(operation).not.toHaveBeenCalled();
});

it("copies and freezes nested intent and environment before reservation awaits", async () => {
  const f = fixture();
  const gate = deferred();
  const reserve = vi.mocked(f.store.reserve).getMockImplementation()!;
  vi.mocked(f.store.reserve).mockImplementation(async (owner) => {
    expect(Object.isFrozen(owner.intent.launch.args)).toBe(true);
    expect(Object.isFrozen(owner.intent.launch.requestedProfile.host)).toBe(true);
    await gate.promise;
    return reserve(owner);
  });
  const input = { ...request(true), runtimeEnv: { TERM: "before", HOME: "/desktop" } };
  const expected = structuredClone(input.intent);
  const pending = f.controller()(input);
  (input.intent.launch.args as string[]).push("mutated");
  Object.assign(input.intent.launch, { cwd: "/mutated", executable: "/bin/bash" });
  Object.assign(input.intent.launch.requestedProfile.host, { username: "wrong" });
  Object.assign(input.intent.wslIdentity!, { username: "wrong", uid: 999 });
  input.intent = request().intent;
  input.runtimeEnv.TERM = "after";
  input.terminalId = "other-pane";
  gate.release();
  const output = await pending;
  expect(output).toMatchObject({ action: "dispatched", owner: { ownerKey, intent: expected } });
  const plan = f.transport.mock.calls[0]![0];
  expect(plan.launch).toEqual(expected.launch);
  expect(plan.invocation.args).toContain("TERM=before");
  expect(JSON.stringify(plan)).not.toContain("mutated");
  expect(JSON.stringify(plan)).not.toContain("/desktop");
  expect(f.entries.get(ownerKey)?.intent).toEqual(expected);
});

it("rejects invalid intent before any store or transport operation", async () => {
  const f = fixture();
  const input = request();
  Object.assign(input.intent.launch, { args: ["different"] });
  await expect(f.controller()(input)).rejects.toThrow("profile");
  expect(f.store.reserve).not.toHaveBeenCalled();
  expect(f.store.get).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
});

it("fails closed on corrupt or wrong-pane stored intent in reserve and recovery", async () => {
  const f = fixture();
  const invalid = { ...prepared(), digest: "0".repeat(64) };
  f.entries.set(ownerKey, invalid);
  await expect(f.controller()(request())).rejects.toThrow("digest");
  await expect(f.controller()({ ...pane, recoverOnly: true })).rejects.toThrow("digest");
  const wrongPane = parseDirectShellLaunchOwner({
    ...prepared(),
    ownerKey: `terminal:${"a".repeat(64)}`,
  });
  f.entries.set(ownerKey, wrongPane);
  await expect(f.controller()(request())).rejects.toThrow("pane identity conflict");
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.store.claimDispatch).not.toHaveBeenCalled();
});
