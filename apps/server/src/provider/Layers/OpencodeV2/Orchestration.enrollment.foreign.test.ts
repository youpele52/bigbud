import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  assertV2PreviousHistoryRetired,
  recoverV2PreviousEnrollment,
} from "./Orchestration.enrollment.recovery.ts";

it("a signed foreign active owner blocks startup history admission and is never detached to manufacture readiness", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("native", "/owned"),
      digest = app.envelope("inspect").ownerDigest;
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const key = JSON.stringify([owner.storageIdentity, owner.nativeSessionId, owner.threadId]);
    await records.replace(key, undefined, {
      owner,
      digest,
      state: "active",
      acknowledged: { revision: 1, expiry: Date.now() + 55000 },
      pending: null,
    });
    const saved = (await records.read(key))!,
      rpc = vi.fn(async () => {
        throw new Error("Foreign RPC must not be issued");
      });
    await expect(
      assertV2PreviousHistoryRetired(records, {
        storageIdentity: owner.storageIdentity,
        nativeSessionId: owner.nativeSessionId,
        threadId: owner.threadId,
        directory: owner.directory,
      }),
    ).rejects.toThrow("not durably physically settled");
    await expect(
      recoverV2PreviousEnrollment(
        records,
        saved,
        { ...owner, enrollmentNonce: "d".repeat(32) },
        "owned-transport",
        rpc,
      ),
    ).rejects.toThrow("not durably physically settled");
    expect(rpc).not.toHaveBeenCalled();
    expect((await records.read(key))?.revision).toBe(saved.revision);
    expect(await (await records.sibling("retirements")).entries()).toEqual([]);
  } finally {
    await app.close();
  }
});
