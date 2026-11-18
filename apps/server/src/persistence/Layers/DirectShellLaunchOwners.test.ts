import { expect, it } from "vitest";
import { fixture, owner } from "./DirectShellLaunchOwners.test.helpers";
import { makeDirectShellLaunchOwners } from "./DirectShellLaunchOwners";
import {
  directShellLaunchDigest,
  directShellOwnerKey,
  parseDirectShellLaunchOwner,
} from "../../terminal/Layers/DirectShellLaunch.owner";
import { shellProfileId } from "../../terminal/Layers/ShellProfiles.identity";
import { remoteShellHost } from "../../terminal/Layers/ShellProfiles.remote.identity";

it("reserves one immutable owner across independent controllers and grants one dispatch permit", async () => {
  const f = await fixture();
  const otherRuntime = await f.open();
  const other = await otherRuntime.runPromise(makeDirectShellLaunchOwners());
  const [left, right] = await Promise.all([
    f.store.reserve(owner("left", "left-controller")),
    other.reserve(owner("right", "right-controller")),
  ]);
  expect(Number(left.created) + Number(right.created)).toBe(1);
  expect(left.owner).toEqual(right.owner);
  const saved = left.owner;
  const attempts = await Promise.all([
    f.store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
    other.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
  ]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect((await f.store.get(saved.ownerKey))?.state).toBe("may-have-been-sent");
  expect(
    await f.store.cancelPrepared(saved.ownerKey, saved.reservationId, saved.controllerId),
  ).toBe(false);
});

it("cancellation and dispatch cannot both succeed", async () => {
  const { store } = await fixture();
  const saved = owner();
  await store.reserve(saved);
  const [cancelled, dispatched] = await Promise.all([
    store.cancelPrepared(saved.ownerKey, saved.reservationId, saved.controllerId),
    store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
  ]);
  expect(Number(cancelled) + Number(dispatched)).toBe(1);
  expect(await store.get(saved.ownerKey)).toEqual(
    cancelled ? undefined : { ...saved, state: "may-have-been-sent" },
  );
});

it("retains possibly-dispatched intent across a database reopen without redispatch or fallback", async () => {
  const f = await fixture();
  const saved = owner();
  await f.store.reserve(saved);
  expect(await f.store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId)).toBe(
    true,
  );
  await f.runtime.dispose();
  const runtime = await f.open();
  const restarted = await runtime.runPromise(makeDirectShellLaunchOwners());
  const attempted = owner("new-reservation", "new-controller");
  const result = await restarted.reserve(attempted);
  expect(result.created).toBe(false);
  expect(result.owner).toEqual({ ...saved, state: "may-have-been-sent" });
  expect(
    await restarted.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
  ).toBe(false);
  expect(
    await restarted.claimDispatch(saved.ownerKey, attempted.reservationId, attempted.controllerId),
  ).toBe(false);
  expect(await restarted.markUnknown(saved.ownerKey, saved.reservationId, saved.controllerId)).toBe(
    true,
  );
  expect(
    await restarted.cancelPrepared(saved.ownerKey, saved.reservationId, saved.controllerId),
  ).toBe(false);
  expect((await restarted.get(saved.ownerKey))?.state).toBe("outcome-unknown");
});

it("only permits rollback before dispatch and fences stale reservation/controller actions", async () => {
  const { store } = await fixture();
  const saved = owner();
  await store.reserve(saved);
  for (const [reservationId, controllerId] of [
    ["other", saved.controllerId],
    [saved.reservationId, "other"],
  ]) {
    expect(await store.claimDispatch(saved.ownerKey, reservationId!, controllerId!)).toBe(false);
    expect(await store.cancelPrepared(saved.ownerKey, reservationId!, controllerId!)).toBe(false);
    expect(await store.markUnknown(saved.ownerKey, reservationId!, controllerId!)).toBe(false);
  }
  expect(await store.markUnknown(saved.ownerKey, saved.reservationId, saved.controllerId)).toBe(
    false,
  );
  expect(await store.cancelPrepared(saved.ownerKey, saved.reservationId, saved.controllerId)).toBe(
    true,
  );
  expect((await store.reserve(owner("new"))).created).toBe(true);
  expect(await store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId)).toBe(
    false,
  );
});

it("does not grant a dispatch permit when persistence fails", async () => {
  const { runtime, store, sql } = await fixture();
  const saved = owner();
  await store.reserve(saved);
  await runtime.runPromise(sql`PRAGMA query_only = ON`);
  await expect(
    store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
  ).rejects.toThrow();
  expect((await store.get(saved.ownerKey))?.state).toBe("prepared");
});

it("validates stored immutable intent and duplicate identity columns before dispatch or rollback", async () => {
  const { runtime, store, sql } = await fixture();
  const saved = owner();
  await store.reserve(saved);
  await runtime.runPromise(sql`UPDATE direct_shell_launch_owners
    SET owner_json = json_set(owner_json, '$.intent.launch.cwd', '/changed')`);
  await expect(
    store.claimDispatch(saved.ownerKey, saved.reservationId, saved.controllerId),
  ).rejects.toThrow("digest");
  await expect(
    store.cancelPrepared(saved.ownerKey, saved.reservationId, saved.controllerId),
  ).rejects.toThrow("digest");
  await runtime.runPromise(sql`UPDATE direct_shell_launch_owners
    SET owner_json = ${JSON.stringify(saved)}, controller_id = 'wrong'`);
  await expect(store.get(saved.ownerKey)).rejects.toThrow("storage identity conflict");
});

it("copies launch arguments before the first asynchronous reservation boundary", async () => {
  const { store } = await fixture();
  const saved = owner();
  const pending = store.reserve(saved);
  (saved.intent.launch.args as string[]).push("mutated-after-call");
  const result = await pending;
  expect(result.owner.intent.launch.args).toEqual(["-o", "nopromptsp"]);
  expect((await store.get(saved.ownerKey))?.intent.launch.args).toEqual(["-o", "nopromptsp"]);
});

it("rejects invalid state, digest, account and execution-target plans before reserving", async () => {
  const { store } = await fixture();
  const saved = owner();
  await expect(store.reserve({ ...saved, state: "outcome-unknown" })).rejects.toThrow(
    "must be prepared",
  );
  await expect(store.reserve({ ...saved, digest: "0".repeat(64) })).rejects.toThrow("digest");
  const otherAccount = {
    ...saved.intent,
    executionTargetId: saved.intent.executionTargetId.replace("tester", "other"),
  };
  expect(() => directShellLaunchDigest(otherAccount)).toThrow("host");
  const agentTarget = {
    ...saved.intent,
    executionTargetId: saved.intent.executionTargetId.replace("direct-ssh", "agent"),
  };
  expect(() => directShellLaunchDigest(agentTarget)).toThrow("agent execution target");
  expect(await store.get(saved.ownerKey)).toBeUndefined();
});

it("binds WSL UID separately from the host-scoped account/profile identity", () => {
  const saved = owner();
  const target = {
    executionTargetId: "wsl:Ubuntu",
    wslIdentity: { distribution: "Ubuntu", username: "tester", uid: 1000 },
  };
  const host = remoteShellHost(target);
  const launch = {
    ...saved.intent.launch,
    requestedProfile: {
      host,
      kind: "zsh" as const,
      profileId: shellProfileId(
        host,
        saved.intent.launch.executable,
        saved.intent.launch.args,
        "linux",
      ),
    },
  };
  const intent = { ...target, launch };
  expect(directShellLaunchDigest(intent)).not.toBe(
    directShellLaunchDigest({
      ...intent,
      wslIdentity: { ...intent.wslIdentity, uid: 1001 },
    }),
  );
  expect(() =>
    directShellLaunchDigest({
      ...intent,
      wslIdentity: { ...intent.wslIdentity, distribution: "Other" },
    }),
  ).toThrow();
});

it("uses framed pane identity and canonical launch field ordering", () => {
  expect(directShellOwnerKey("a:b", "c")).not.toBe(directShellOwnerKey("a", "b:c"));
  expect(() => directShellOwnerKey("", "pane")).toThrow();
  const saved = owner();
  expect(parseDirectShellLaunchOwner(saved)).toEqual(saved);
  expect(
    directShellLaunchDigest({
      launch: saved.intent.launch,
      executionTargetId: saved.intent.executionTargetId,
    }),
  ).toBe(saved.digest);
});
