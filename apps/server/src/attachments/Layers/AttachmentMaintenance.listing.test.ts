import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, assert, it } from "vitest";

import { makeAttachmentRootLister } from "./AttachmentMaintenance.listing.ts";

const roots: Array<string> = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("reuses the listing while the root is unchanged and re-reads it after any change", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bigbud-attachment-listing-"));
  roots.push(root);
  await writeFile(path.join(root, "notes.txt"), "not managed");
  const lister = makeAttachmentRootLister();

  // Just changed: within the timestamp granularity, so never reused.
  await lister.read(root);
  await lister.read(root);
  assert.equal(lister.readCount(), 2);

  await sleep(2_100);
  const first = await lister.read(root);
  const again = await lister.read(root);
  assert.equal(lister.readCount(), 3);
  assert.strictEqual(again, first);

  // A new entry changes the directory, so the next read sees it.
  await writeFile(path.join(root, "added.txt"), "x");
  const fresh = await lister.read(root);
  assert.equal(lister.readCount(), 4);
  assert.include(typeof fresh === "string" ? [] : fresh.names, "added.txt");

  assert.equal(await lister.read(path.join(root, "missing")), "missing");
  assert.equal(await lister.read(path.join(root, "notes.txt")), "invalid");
});
