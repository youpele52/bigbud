import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  ensureV2ReceiptFence,
  readV2OwnerMarker,
  readV2ReceiptFence,
  writeV2OwnerMarker,
} from "./Orchestration.instances.ts";

const instance = {
  nonce: "1".repeat(32),
  pid: 4242,
  startedAt: null,
  hostname: "fixture-host",
};

async function withRecords(run: (records: V2ThreadRecords) => Promise<void>) {
  const app = await makeV2ThreadPluginFixture();
  try {
    await run(
      await V2ThreadRecords.open(
        app.artifact.root,
        "enrollments",
        app.artifact.privateKey,
        app.artifact.publicKey,
      ),
    );
  } finally {
    await app.close();
  }
}

it("owner attribution is signed, idempotent and never silently rewritten", async () => {
  await withRecords(async (records) => {
    const digest = "d".repeat(64);
    expect(await readV2OwnerMarker(records, digest)).toBeUndefined();
    await writeV2OwnerMarker(records, instance, digest, "e".repeat(32));
    await writeV2OwnerMarker(records, instance, digest, "e".repeat(32));
    expect(await readV2OwnerMarker(records, digest)).toMatchObject({
      backendInstance: instance.nonce,
      pid: 4242,
    });
    await expect(
      writeV2OwnerMarker(records, { ...instance, nonce: "2".repeat(32) }, digest, "e".repeat(32)),
    ).rejects.toThrow("attribution changed");
  });
});

it("the receipt fence captures only receipts reserved before it, is reused, and rejects tampering", async () => {
  await withRecords(async (records) => {
    const receipts = await records.sibling("receipts");
    await receipts.replace("dead-reserved", undefined, { fingerprint: "a", state: "reserved" });
    await receipts.replace("dead-completed", undefined, {
      fingerprint: "b",
      state: "completed",
      result: { content: "{}" },
    });
    const fence = await ensureV2ReceiptFence(records, instance);
    expect(fence.receipts.size).toBe(1);
    await receipts.replace("live-reserved", undefined, { fingerprint: "c", state: "reserved" });
    const reused = await ensureV2ReceiptFence(records, instance);
    expect(reused.digest).toBe(fence.digest);
    expect(reused.receipts.size).toBe(1);
    expect((await readV2ReceiptFence(records, instance.nonce, fence.digest)).receipts).toEqual(
      fence.receipts,
    );
    await expect(readV2ReceiptFence(records, instance.nonce, "0".repeat(64))).rejects.toThrow(
      "missing or changed",
    );
    const directory = path.join(path.dirname(records.directory), "instances");
    const [name] = await readdir(directory);
    const file = path.join(directory, name!);
    const signed = JSON.parse(await readFile(file, "utf8"));
    signed.value.receipts = [];
    await writeFile(file, JSON.stringify(signed));
    await expect(ensureV2ReceiptFence(records, instance)).rejects.toThrow("signed record rejected");
  });
});
