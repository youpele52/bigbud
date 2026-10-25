import { randomBytes, sign } from "node:crypto";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import {
  signV2LegacyCleanup,
  v2LegacyThreadEnvelopeBytes,
  v2LegacyThreadOwnerDigest,
  type V2LegacyThreadEnvelope,
  type V2LegacyThreadOwner,
} from "./Orchestration.protocol.legacy.ts";

/** Validly signed historical replay; production's cleanup signer must not issue these operations. */
function signHistoricalReplay(envelope: Omit<V2LegacyThreadEnvelope, "signature">, key: string) {
  return {
    ...envelope,
    signature: sign(null, v2LegacyThreadEnvelopeBytes(envelope), key).toString("base64url"),
  };
}

it("N accepts exact L cleanup only; legacy tombstones cannot revoke the same-nonce N successor or create callback authority", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("legacy-cleanup-successor", app.root),
      host = makeV2ThreadPluginHost(owner),
      plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default,
      cleanup = await plugin.setup(host.context);
    try {
      expect(await host.call("info")).toMatchObject({
        protocol: `bigbud.thread.v2.${app.artifact.issuer}`,
        enrollmentProtocol: "bigbud.thread.enrollment.v2",
        bootstrapAbi: app.artifact.bootstrapAbi,
      });
      const expiry = Date.now() + 40000,
        enrolled = await host.call("enroll", app.envelope("enroll", 1, expiry));
      const legacy: V2LegacyThreadOwner = {
        protocol: "bigbud.thread.v1",
        issuer: owner.issuer,
        artifactDigest: owner.bootstrapDigest,
        threadId: owner.threadId,
        nativeSessionId: owner.nativeSessionId,
        storageIdentity: owner.storageIdentity,
        directory: owner.directory,
        runtimeTargetId: owner.runtimeTargetId,
        workspaceTargetId: owner.workspaceTargetId,
        sessionEpoch: owner.sessionEpoch,
        transportGeneration: owner.transportGeneration,
        consentRevision: owner.consentRevision,
        enrollmentNonce: owner.enrollmentNonce,
        callbackUrl: owner.callbackUrl,
        callbackToken: owner.callbackToken,
      };
      const envelope = (operation: V2LegacyThreadEnvelope["operation"]) => ({
        protocol: "bigbud.thread.v1" as const,
        operation,
        issuer: owner.issuer,
        ownerDigest: v2LegacyThreadOwnerDigest(legacy),
        enrollmentNonce: owner.enrollmentNonce,
        requestId: randomBytes(16).toString("hex"),
        authExpiresAt: Date.now() + 14000,
        leaseRevision: operation === "enroll" || operation === "renew" ? 1 : null,
        leaseExpiresAt: operation === "enroll" || operation === "renew" ? expiry : null,
        owner: operation === "enroll" ? legacy : null,
      });
      for (const operation of ["enroll", "renew"] as const) {
        const replay = signHistoricalReplay(envelope(operation), app.artifact.privateKey);
        await expect(host.call(operation, replay)).rejects.toThrow();
        await expect(host.call(operation, replay)).rejects.toThrow();
      }
      expect(
        await host.call(
          "inspect",
          signV2LegacyCleanup(envelope("inspect"), app.artifact.privateKey),
        ),
      ).toMatchObject({ state: "missing", revision: 0, expiry: 0 });
      const detached = await host.call(
        "detach",
        signV2LegacyCleanup(envelope("detach"), app.artifact.privateKey),
      );
      expect(detached).toMatchObject({
        state: "revoked",
        ownerDigest: v2LegacyThreadOwnerDigest(legacy),
        enrollmentNonce: owner.enrollmentNonce,
        revision: 0,
        expiry: 0,
      });
      expect(
        await host.call(
          "inspect",
          signV2LegacyCleanup(envelope("inspect"), app.artifact.privateKey),
        ),
      ).toEqual(detached);
      expect(
        await host.call("detach", signV2LegacyCleanup(envelope("detach"), app.artifact.privateKey)),
      ).toEqual(detached);
      // Deliberately collide both digest and nonce across wire domains: N authority still survives.
      await host.call(
        "detach",
        signV2LegacyCleanup(
          { ...envelope("detach"), ownerDigest: enrolled.ownerDigest as string },
          app.artifact.privateKey,
        ),
      );
      expect(await host.call("inspect", app.envelope("inspect"))).toEqual(enrolled);
      expect(Object.keys((await host.request(owner.nativeSessionId)).tools)).toHaveLength(5);
      expect(app.state.invocations).toHaveLength(0);
      await host.call("detach", app.envelope("detach"));
      await expect(host.request(owner.nativeSessionId)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});

it("N legacy cleanup rejects malformed, mismatched and unauthorized envelopes without adding a tombstone", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("cleanup-bounds", app.root),
      host = makeV2ThreadPluginHost(owner),
      plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default,
      cleanup = await plugin.setup(host.context);
    const input: Omit<V2LegacyThreadEnvelope, "signature"> = {
      protocol: "bigbud.thread.v1",
      operation: "detach",
      issuer: owner.issuer,
      ownerDigest: "a".repeat(64),
      enrollmentNonce: "b".repeat(32),
      requestId: randomBytes(16).toString("hex"),
      authExpiresAt: Date.now() + 14000,
      leaseRevision: null,
      leaseExpiresAt: null,
      owner: null,
    };
    try {
      const valid = signV2LegacyCleanup(input, app.artifact.privateKey);
      for (const invalid of [
        { ...valid, extra: true },
        { ...valid, signature: "a".repeat(86) },
        { ...valid, ownerDigest: "c".repeat(64) },
        { ...valid, protocol: "bigbud.thread.enrollment.v2" },
        signHistoricalReplay({ ...input, leaseRevision: 1 }, app.artifact.privateKey),
        signHistoricalReplay(
          { ...input, leaseExpiresAt: Date.now() + 1000 },
          app.artifact.privateKey,
        ),
        signHistoricalReplay({ ...input, issuer: "d".repeat(64) }, app.artifact.privateKey),
        signHistoricalReplay({ ...input, authExpiresAt: Date.now() - 1 }, app.artifact.privateKey),
        signHistoricalReplay(
          { ...input, authExpiresAt: Date.now() + 60000 },
          app.artifact.privateKey,
        ),
      ]) {
        await expect(host.call("detach", invalid)).rejects.toThrow();
        expect(
          await host.call(
            "inspect",
            signV2LegacyCleanup(
              { ...input, operation: "inspect", requestId: randomBytes(16).toString("hex") },
              app.artifact.privateKey,
            ),
          ),
        ).toMatchObject({ state: "missing", revision: 0, expiry: 0 });
      }
      await expect(host.call("inspect", valid)).rejects.toThrow();
      expect(Object.keys((await host.request(owner.nativeSessionId)).tools)).toHaveLength(0);
      expect(app.state.invocations).toHaveLength(0);
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});
