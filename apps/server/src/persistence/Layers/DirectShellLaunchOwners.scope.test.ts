import { expect, it } from "vitest";
import { fixture, owner } from "./DirectShellLaunchOwners.test.helpers";
import { makeDirectShellLaunchOwners } from "./DirectShellLaunchOwners";
import { parseDirectShellLaunchOwner } from "../../terminal/Layers/DirectShellLaunch.owner";

it("retains validated scope across reopening without changing the launch digest", async () => {
  const db = await fixture();
  const original = owner();
  const scoped = { ...original, pane: { threadId: "thread", terminalId: "pane" } };
  expect(parseDirectShellLaunchOwner(scoped).digest).toBe(original.digest);
  await db.store.reserve(scoped);
  await db.runtime.dispose();
  const reopened = await db.open();
  const recovered = await reopened.runPromise(makeDirectShellLaunchOwners());
  expect(await recovered.hasOwnersForThread("thread")).toBe(true);
  expect(await recovered.hasOwnersForThread("other")).toBe(false);
});

it("preserves legacy bytes and treats unscoped ownership conservatively", async () => {
  const db = await fixture();
  const original = owner();
  await db.store.reserve(original);
  expect(await db.store.hasOwnersForThread("unrelated")).toBe(true);
  expect(await db.store.get(original.ownerKey)).toEqual(original);
});

it("rejects forged pane scope both at reservation and after storage corruption", async () => {
  const db = await fixture();
  const original = owner();
  const forged = { ...original, pane: { threadId: "other", terminalId: "pane" } };
  await expect(db.store.reserve(forged)).rejects.toThrow("pane identity conflict");
  await db.store.reserve(original);
  await db.runtime.runPromise(
    db.sql`UPDATE direct_shell_launch_owners SET owner_json = ${JSON.stringify(forged)}`,
  );
  await expect(db.store.hasOwnersForThread("thread")).rejects.toThrow("pane identity conflict");
});
