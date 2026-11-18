import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitRuntimeArchivePointer,
  listRuntimeArchivePointerSequences,
  readRuntimeArchivePointer,
} from "./runtimeArchive.pointer.ts";
import { pruneRuntimeArchives } from "./runtimeArchive.retention.ts";
import {
  activateRuntimeArchive,
  pinRuntimeArchive,
  releaseRuntimeArchive,
  reserveRuntimeArchive,
} from "./runtimeArchive.store.ts";
import {
  makeRuntimeArchiveFixture,
  presentKeys,
  stageRuntimeArchive,
} from "./runtimeArchive.test.helpers.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
});
const sorted = (...keys: string[]) => keys.toSorted();

describe("runtime archive retention", () => {
  it("retention_never_prunes_pinned", async () => {
    const store = await (await makeRuntimeArchiveFixture(cleanup)).open();
    const [a, b, c, d] = [
      await stageRuntimeArchive(store, "1.0.0"),
      await stageRuntimeArchive(store, "1.1.0"),
      await stageRuntimeArchive(store, "1.2.0"),
      await stageRuntimeArchive(store, "1.3.0"),
    ];
    for (const key of [a, b, c, d]) await activateRuntimeArchive(store, key);
    await pinRuntimeArchive(store, a);
    // Active d, previous c, pinned a, in-use b (an old process still draining).
    const result = await pruneRuntimeArchives(store, { inUse: [b] });
    expect(result.pruned).toEqual([]);
    expect(await presentKeys(store)).toEqual(sorted(a, b, c, d));
    // Once b is no longer in use it goes; the pinned version still stays.
    expect((await pruneRuntimeArchives(store)).pruned).toEqual([b]);
    expect(await presentKeys(store)).toEqual(sorted(a, c, d));
    await pinRuntimeArchive(store, a, false);
    expect((await pruneRuntimeArchives(store)).pruned).toEqual([a]);
  });

  it("keeps the active and previous runtimes and every pending reservation", async () => {
    const store = await (await makeRuntimeArchiveFixture(cleanup)).open();
    const one = await stageRuntimeArchive(store, "1.0.0");
    const two = await stageRuntimeArchive(store, "2.0.0");
    const three = await stageRuntimeArchive(store, "3.0.0");
    await activateRuntimeArchive(store, one);
    await activateRuntimeArchive(store, two);
    // three is staged (pending) but not activated: it must survive.
    expect((await pruneRuntimeArchives(store)).pruned).toEqual([]);
    await activateRuntimeArchive(store, three);
    const result = await pruneRuntimeArchives(store);
    expect(result.pruned).toEqual([one]);
    expect(result.pointer).toMatchObject({ active: three, previous: two, pending: [] });
    expect(await presentKeys(store)).toEqual(sorted(two, three));
    // A rollback swaps active and previous; nothing else becomes prunable.
    await activateRuntimeArchive(store, two);
    expect((await pruneRuntimeArchives(store)).pruned).toEqual([]);
    expect(await readRuntimeArchivePointer(store)).toMatchObject({ active: two, previous: three });
  });

  it("prunes only after the durable commit: a crash between steps loses nothing", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    let crashOnPublish = false;
    const store = await fixture.open(async () => {
      if (crashOnPublish) throw new Error("simulated crash");
    });
    const old = await stageRuntimeArchive(store, "1.0.0");
    const older = await stageRuntimeArchive(store, "0.9.0");
    await activateRuntimeArchive(store, older);
    await activateRuntimeArchive(store, old);
    const next = await stageRuntimeArchive(store, "2.0.0");
    // Crash while committing the new active pointer: the old pointer still governs retention.
    crashOnPublish = true;
    await expect(activateRuntimeArchive(store, next)).rejects.toThrow("simulated crash");
    crashOnPublish = false;
    const restarted = await fixture.open();
    expect(await readRuntimeArchivePointer(restarted)).toMatchObject({
      active: old,
      previous: older,
      pending: [next],
    });
    expect((await pruneRuntimeArchives(restarted)).pruned).toEqual([]);
    // Commit succeeds, then a crash before pruning: every version is still on disk.
    await activateRuntimeArchive(restarted, next);
    const afterCrash = await fixture.open();
    expect(await presentKeys(afterCrash)).toEqual(sorted(older, old, next));
    // The next run prunes exactly the version the committed pointer released.
    expect((await pruneRuntimeArchives(afterCrash)).pruned).toEqual([older]);
    expect(await presentKeys(afterCrash)).toEqual(sorted(old, next));
  });

  it("finishes a delete interrupted after the trash rename and refuses a racing commit", async () => {
    const fixture = await makeRuntimeArchiveFixture(cleanup);
    let commitDuringPrune = false;
    const store = await fixture.open(async () => {
      if (!commitDuringPrune) return;
      commitDuringPrune = false;
      await reserveRuntimeArchive(store, gone);
    });
    const gone = await stageRuntimeArchive(store, "1.0.0");
    const kept = await stageRuntimeArchive(store, "2.0.0");
    await activateRuntimeArchive(store, kept);
    await releaseRuntimeArchive(store, gone);
    // Simulated crash after the atomic rename: only a trash member remains.
    await fs.mkdir(join(store.trash, "leftover.partial", "graph"), { recursive: true });
    // A commit that re-reserves `gone` mid-prune must stop the prune before it deletes it.
    let checkpoints = 0;
    const counting = {
      ...store,
      checkpoint: async () => {
        // 1: start, 2: trash leftover, 3: first prune step (after the pointer was read).
        if (++checkpoints === 3) commitDuringPrune = true;
        await store.checkpoint();
      },
    };
    await expect(pruneRuntimeArchives(counting)).rejects.toThrow("pointer changed");
    expect(await presentKeys(store)).toEqual(sorted(gone, kept));
    expect(await fs.readdir(store.trash)).toEqual([]);
    expect((await readRuntimeArchivePointer(store)).pending).toEqual([gone]);
  });

  it("is idempotent and keeps pointer history bounded", async () => {
    const store = await (await makeRuntimeArchiveFixture(cleanup)).open();
    const a = await stageRuntimeArchive(store, "1.0.0");
    const b = await stageRuntimeArchive(store, "1.1.0");
    const c = await stageRuntimeArchive(store, "1.2.0");
    for (const key of [a, b, c]) await activateRuntimeArchive(store, key);
    const first = await pruneRuntimeArchives(store);
    const second = await pruneRuntimeArchives(store);
    expect(first.pruned).toEqual([a]);
    expect(second.pruned).toEqual([]);
    expect(second.retained).toEqual(first.retained);
    expect(await listRuntimeArchivePointerSequences(store)).toHaveLength(2);
    expect((await readRuntimeArchivePointer(store)).sequence).toBe(first.pointer.sequence);
  });

  it("prunes nothing before any pointer was committed", async () => {
    const store = await (await makeRuntimeArchiveFixture(cleanup)).open();
    const key = "0.1.0@" + "b".repeat(64);
    await fs.mkdir(join(store.entries, key), { mode: 0o700 });
    expect((await pruneRuntimeArchives(store)).pruned).toEqual([]);
    expect(await presentKeys(store)).toEqual([key]);
    // The first commit, even of an empty state, is the first durable pointer.
    const committed = await commitRuntimeArchivePointer(store, (current) => current);
    expect(committed.sequence).toBe(1);
  });
});
