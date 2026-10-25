import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { v2ThreadOwnerDigest } from "./Orchestration.protocol.ts";
import { selectV2SessionArtifact } from "./Orchestration.selection.ts";

it("fresh scoped sessions never select a legacy artifact; signed retained legacy history keeps its exact artifact permanently", async () => {
  const old = await makeV2ThreadPluginFixture({ legacyRegistration: true });
  try {
    const preferred = await exportV2ThreadArtifact(old.root);
    const records = await V2ThreadRecords.open(
      preferred.root,
      "enrollments",
      preferred.privateKey,
      preferred.publicKey,
    );
    const owner = old.bind("native-history", "/workspace");
    const identity = {
      nativeSessionId: owner.nativeSessionId,
      threadId: owner.threadId,
      storageIdentity: owner.storageIdentity,
      directory: owner.directory,
      registrationFamily: "legacy" as const,
    };
    await expect(selectV2SessionArtifact(preferred, records, identity)).rejects.toThrow("unproved");
    expect(
      (
        await selectV2SessionArtifact(preferred, records, {
          ...identity,
          registrationFamily: "scoped",
        })
      ).artifactDigest,
    ).toBe(preferred.artifactDigest);
    await records.replace("retained", undefined, {
      owner,
      digest: v2ThreadOwnerDigest(owner),
      state: "revoked",
      acknowledged: { revision: 1, expiry: 1 },
      pending: null,
    });
    const before = await records.inventory();
    expect((await selectV2SessionArtifact(preferred, records, identity)).artifactDigest).toBe(
      old.artifact.artifactDigest,
    );
    await expect(
      selectV2SessionArtifact(preferred, records, { ...identity, registrationFamily: "scoped" }),
    ).rejects.toThrow("cross-family");
    await expect(
      selectV2SessionArtifact(preferred, records, { ...identity, threadId: "foreign-thread" }),
    ).rejects.toThrow("conflicts");
    expect(await records.inventory()).toEqual(before);
    await old.artifact.verify();
  } finally {
    await old.close();
  }
});
