import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeArchiveKeyForManifest } from "./runtimeArchive.key.ts";
import { readRuntimeArchivePointer } from "./runtimeArchive.pointer.ts";
import {
  activateRuntimeArchive,
  openRuntimeArchiveStore,
  readRuntimeArchiveEntry,
  recordRuntimeArchive,
  releaseRuntimeArchive,
  reserveRuntimeArchive,
  runtimeArchiveStoreRoot,
} from "./runtimeArchive.store.ts";
import {
  makeRuntimeArchiveFixture,
  signedManifest,
  stageRuntimeArchive,
  verifyGraphAt,
  writeGraph,
} from "./runtimeArchive.test.helpers.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});

describe("runtime archive store", () => {
  it("keys entries by version and manifest digest and records the verified identity", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    const store = await fixture.open();
    const key = await stageRuntimeArchive(store, "1.2.0");
    expect(key).toMatch(/^1\.2\.0@[a-f0-9]{64}$/);
    const entry = await readRuntimeArchiveEntry(store, key);
    expect(entry).toMatchObject({
      key,
      version: "1.2.0",
      target: "aarch64-unknown-linux-gnu",
      graphRoot: join(store.entries, key, "graph"),
    });
    expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(store.entries, key, "entry-v1"))).mode & 0o777).toBe(0o600);
    expect((await readRuntimeArchivePointer(store)).pending).toEqual([key]);
  });

  it("is idempotent: re-open, re-reserve, re-record and re-activate change nothing", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    const store = await fixture.open();
    const key = await stageRuntimeArchive(store, "1.0.0");
    const activated = await activateRuntimeArchive(store, key);
    const reopened = await fixture.open();
    await reserveRuntimeArchive(reopened, key);
    const graphRoot = join(reopened.entries, key, "graph");
    await recordRuntimeArchive(reopened, await verifyGraphAt(graphRoot, "1.0.0"));
    const pointer = await readRuntimeArchivePointer(reopened);
    expect(pointer.active).toBe(key);
    // Reserving an already active version adds a pending hold; activating again clears it.
    expect(pointer.pending).toEqual([key]);
    const again = await activateRuntimeArchive(reopened, key);
    expect(again).toMatchObject({ active: key, previous: null, pending: [] });
    expect(again.sequence).toBe(activated.sequence + 2);
    expect((await activateRuntimeArchive(reopened, key)).sequence).toBe(again.sequence);
  });

  it("refuses a graph outside its reserved slot, an unreserved key and an incomplete activation", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    const store = await fixture.open();
    const outside = join(fixture.parent, "elsewhere");
    await writeGraph(outside, "2.0.0");
    await expect(
      recordRuntimeArchive(store, await verifyGraphAt(outside, "2.0.0")),
    ).rejects.toThrow("reserved runtime archive slot");
    const key = runtimeArchiveKeyForManifest(signedManifest("2.0.0"));
    const slot = await reserveRuntimeArchive(store, key);
    await expect(activateRuntimeArchive(store, key)).rejects.toThrow("complete recorded");
    await writeGraph(slot.graphRoot, "2.0.0");
    const token = await verifyGraphAt(slot.graphRoot, "2.0.0");
    await releaseRuntimeArchive(store, key);
    await expect(recordRuntimeArchive(store, token)).rejects.toThrow("reserved before");
    expect(await readRuntimeArchiveEntry(store, key)).toBeNull();
  });

  it("refuses a modified extraction because the original proof is revalidated", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    const store = await fixture.open();
    const key = runtimeArchiveKeyForManifest(signedManifest("3.0.0"));
    const slot = await reserveRuntimeArchive(store, key);
    await writeGraph(slot.graphRoot, "3.0.0");
    const token = await verifyGraphAt(slot.graphRoot, "3.0.0");
    await fs.writeFile(join(slot.graphRoot, "entry.mjs"), "tampered", { mode: 0o600 });
    await expect(recordRuntimeArchive(store, token)).rejects.toThrow();
    expect(await readRuntimeArchiveEntry(store, key)).toBeNull();
  });

  it("keeps the store root separate from backend mutable state", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    await expect(
      openRuntimeArchiveStore({
        root: join(fixture.backendHome, "runtimes"),
        mutableRoots: [fixture.backendHome],
      }),
    ).rejects.toThrow("outside mutable");
    await expect(openRuntimeArchiveStore({ root: fixture.root, mutableRoots: [] })).rejects.toThrow(
      "mutable roots",
    );
    expect(runtimeArchiveStoreRoot("/home/a", "auth-1")).toBe(
      "/home/a/.bigbud/backend-runtimes/auth-1",
    );
    expect(() => runtimeArchiveStoreRoot("/home/a", "../x")).toThrow();
  });

  it("refuses unknown members instead of guessing what they are", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    const store = await fixture.open();
    await fs.writeFile(join(store.pointers, "pointer-latest"), "{}", { mode: 0o600 });
    await expect(readRuntimeArchivePointer(store)).rejects.toThrow("unknown member");
  });
});
