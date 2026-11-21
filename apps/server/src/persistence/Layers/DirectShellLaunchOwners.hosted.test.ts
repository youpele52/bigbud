import { expect, it } from "vitest";

import { directShellOwnerKey } from "../../terminal/Layers/DirectShellLaunch.owner";
import {
  hostedDirectShellOwner,
  parseHostedDirectShellOwner,
} from "../../terminal/Layers/DirectShellLaunch.hosted";
import { makeDirectShellLaunchOwners } from "./DirectShellLaunchOwners";
import { fixture, owner } from "./DirectShellLaunchOwners.test.helpers";

const target = "ssh:host=example.test&user=tester&transport=direct-ssh";
const pane = { threadId: "thread", terminalId: "pane" };

it("reserves, lists and releases hosted Direct SSH records, surviving a reopen", async () => {
  const db = await fixture();
  const record = hostedDirectShellOwner({ ...pane, executionTargetId: target });
  const first = await db.store.reserveHosted!(record);
  expect(first).toEqual({ created: true, owner: record });
  // A second reservation for the pane keeps the first record (its binding wins).
  const again = await db.store.reserveHosted!(
    hostedDirectShellOwner({ ...pane, executionTargetId: `${target}&port=2222` }),
  );
  expect(again).toEqual({ created: false, owner: record });
  await db.runtime.dispose();
  const reopened = await (await db.open()).runPromise(makeDirectShellLaunchOwners());
  expect(await reopened.getHosted!(record.ownerKey)).toEqual(record);
  expect(await reopened.listHostedForThread!("thread")).toEqual([record]);
  expect(await reopened.listHostedForThread!("other")).toEqual([]);
  // Only the exact record is released; a stale copy changes nothing.
  expect(await reopened.releaseHosted!({ ...record, reservationId: "stale" })).toBe(false);
  expect(await reopened.releaseHosted!(record)).toBe(true);
  expect(await reopened.getHosted!(record.ownerKey)).toBeUndefined();
});

it("keeps hosted records invisible to every legacy member, so their semantics are unchanged", async () => {
  const db = await fixture();
  const record = hostedDirectShellOwner({ ...pane, executionTargetId: target });
  await db.store.reserveHosted!(record);
  expect(await db.store.get(record.ownerKey)).toBeUndefined();
  expect(await db.store.hasOwnersForThread!("thread")).toBe(false);
  expect(await db.store.listForThread!("thread", () => true)).toEqual([]);
  expect(await db.store.forgetForThread!("thread", () => true)).toBe(0);
  expect(await db.store.getHosted!(record.ownerKey)).toEqual(record);
  // The legacy dispatcher cannot reserve over a hosted pane either.
  await expect(db.store.reserve({ ...owner(), ownerKey: record.ownerKey })).rejects.toThrow();
});

it("never turns a legacy owner into a hosted record", async () => {
  const db = await fixture();
  const legacy = { ...owner(), ownerKey: directShellOwnerKey(pane.threadId, pane.terminalId) };
  await db.store.reserve(legacy);
  await expect(
    db.store.reserveHosted!(hostedDirectShellOwner({ ...pane, executionTargetId: target })),
  ).rejects.toThrow(/unconfirmed direct shell owner/);
  expect(await db.store.getHosted!(legacy.ownerKey)).toBeUndefined();
  expect(await db.store.get(legacy.ownerKey)).toEqual(legacy);
});

it("validates the record's pane binding and refuses extra fields", () => {
  const record = hostedDirectShellOwner({ ...pane, executionTargetId: target });
  expect(() =>
    parseHostedDirectShellOwner({ ...record, pane: { threadId: "other", terminalId: "pane" } }),
  ).toThrow(/pane identity/);
  expect(() => parseHostedDirectShellOwner({ ...record, extra: true })).toThrow();
});
