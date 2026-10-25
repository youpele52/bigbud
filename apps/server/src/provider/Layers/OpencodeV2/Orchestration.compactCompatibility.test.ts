import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2HexRegistrationFixture } from "./Orchestration.registration.legacy.fixture.ts";
import {
  V2_N3_BOOTSTRAP_COMPATIBILITY,
  V2_N3_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { v2ThreadOwnerDigest } from "./Orchestration.protocol.ts";
import { selectV2SessionArtifact } from "./Orchestration.selection.ts";
import {
  v2CompactNativeSessionId,
  v2ScopedNativeSessionPrefix,
} from "./Orchestration.sessionIdentity.ts";
import { makeV2RegistryRaceFixture } from "./Orchestration.registry.races.fixture.ts";
import { readV2CompatibleManualBootstrap } from "./Orchestration.readiness.manual.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import type { OpencodeV2Client } from "./Client.ts";

it("freezes the exact previous descriptor and signed byte closure without downgrading compact histories", async () => {
  expect(
    createHash("sha256").update(JSON.stringify(V2_N3_BOOTSTRAP_COMPATIBILITY)).digest("hex"),
  ).toBe(V2_N3_COMPATIBILITY_DIGEST);
  const f = await makeV2ThreadPluginFixture();
  try {
    const old = await makeV2HexRegistrationFixture(f.artifact);
    expect(old.bootstrapAbi).toBe("bigbud.thread.bootstrap.v2");
    expect(f.artifact.bootstrapAbi).toBe("bigbud.thread.bootstrap.v3");
    expect(old.artifactDigest).not.toBe(f.artifact.artifactDigest);
    const oldBytes = await readFile(path.join(old.directory, "registry.mjs"), "utf8");
    const newBytes = await readFile(path.join(f.artifact.directory, "registry.mjs"), "utf8");
    expect(oldBytes).not.toContain("ses_bb3_");
    expect(newBytes).toContain("ses_bb3_");
    expect(newBytes).toContain("ses_bigbud_v2_");
    const client = {
      plugin: {
        list: async () => ({
          data: [
            {
              id: `bigbud.thread.v2.${f.artifact.issuer}`,
              source: { type: "local", path: old.directory },
            },
          ],
        }),
      },
      rpc: { call: async () => ({ output: {} }) },
    } as unknown as OpencodeV2Client;
    await runV2RequestContext(
      {
        transport: "synthetic",
        intent: "execute",
        permit: {
          revision: 1,
          signal: new AbortController().signal,
          assertCurrent: () => {},
          release: () => {},
        },
      },
      async () => {
        await expect(
          readV2CompatibleManualBootstrap(
            f.artifact,
            client,
            "/workspace",
            undefined,
            makeV2SyntheticNativeEligibility(client, f.artifact, f.root),
            f.root,
          ),
        ).rejects.toThrow("no compact-session downgrade");
      },
    );
    const records = await V2ThreadRecords.open(
      f.root,
      "enrollments",
      f.artifact.privateKey,
      f.artifact.publicKey,
    );
    for (const compact of [false, true]) {
      const nativeSessionId = compact
        ? v2CompactNativeSessionId(f.artifact.issuer, "a".repeat(64))
        : `${v2ScopedNativeSessionPrefix(f.artifact.issuer)}${"a".repeat(64)}`;
      const owner = {
        ...f.bind(nativeSessionId, "/workspace"),
        bootstrapDigest: old.artifactDigest,
        bootstrapAbi: old.bootstrapAbi,
        compatibilityDigest: old.compatibilityDigest,
      };
      await records.replace(`old-${compact}`, undefined, {
        owner,
        digest: v2ThreadOwnerDigest(owner),
        state: "revoked",
        acknowledged: { revision: 1, expiry: 1 },
        pending: null,
      });
      const identity = {
        nativeSessionId,
        threadId: owner.threadId,
        storageIdentity: owner.storageIdentity,
        directory: owner.directory,
        registrationFamily: "scoped" as const,
      };
      if (compact)
        await expect(selectV2SessionArtifact(f.artifact, records, identity)).rejects.toThrow(
          "no downgrade",
        );
      else
        expect((await selectV2SessionArtifact(f.artifact, records, identity)).artifactDigest).toBe(
          old.artifactDigest,
        );
    }
    await old.verify();
    expect(await readFile(path.join(old.directory, "registry.mjs"), "utf8")).toBe(oldBytes);
  } finally {
    await f.close();
  }
});

it("compact namespaces deny unregistered work and require the signed owner plus the complete issuer", async () => {
  const f = await makeV2RegistryRaceFixture();
  try {
    const owner = f.owner(1, "compact");
    await expect(f.host.request(owner.nativeSessionId)).rejects.toThrow();
    const signed = f.envelope(owner, "enroll", 1, Date.now() + 50000);
    await expect(f.host.call("enroll", { ...signed, signature: "a".repeat(86) })).rejects.toThrow();
    const foreign = {
      ...owner,
      nativeSessionId: v2CompactNativeSessionId("f".repeat(64), "a".repeat(64)),
    };
    await expect(
      f.host.call("enroll", f.envelope(foreign, "enroll", 1, Date.now() + 50000)),
    ).rejects.toThrow();
    await expect(
      f.host.call("enroll", f.envelope(owner, "enroll", 1, Date.now() + 50000)),
    ).resolves.toMatchObject({ state: "active" });
  } finally {
    await f.close();
  }
});
