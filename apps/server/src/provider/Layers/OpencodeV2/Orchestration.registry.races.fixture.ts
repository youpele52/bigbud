import { randomBytes, sign } from "node:crypto";
import {
  v2ScopedNativeSessionPrefix,
  v2CompactNativeSessionId,
} from "./Orchestration.sessionIdentity.ts";
import { v2NativeRegistrationMetadata } from "./Runtime.registration.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { openV2ThreadTransport } from "./Orchestration.transport.ts";
import { signV2ThreadCallbackResponse } from "./Orchestration.response.ts";
import { openV2ThreadEncryptedRequest } from "./Orchestration.crypto.ts";
import {
  signV2ThreadEnvelope,
  v2ThreadOwnerDigest,
  type V2ThreadEnvelope,
  type V2ThreadOwner,
} from "./Orchestration.protocol.ts";

/** Many disposable native owners, with independently held proof/status work for deterministic races. */
export async function makeV2RegistryRaceFixture() {
  const app = await makeV2ThreadPluginFixture();
  const owners = new Map<string, V2ThreadOwner>();
  let holdProof: (() => Promise<void>) | undefined;
  let holdStatus: (() => Promise<void>) | undefined;
  const transport = await openV2ThreadTransport(async (value) => {
    const encrypted = openV2ThreadEncryptedRequest(value, app.artifact.encryptionPrivateKey);
    const token = encrypted.token;
    const input = encrypted.payload as {
      kind: string;
      ownerDigest: string;
      requestNonce: string;
      enrollmentNonce: string;
      leaseRevision: number;
      leaseExpiresAt: number;
      revision: number;
      expiry: number;
      challenge: string;
    };
    const owner = [...owners.values()].find((candidate) => candidate.callbackToken === token);
    if (!owner || input.ownerDigest !== v2ThreadOwnerDigest(owner))
      throw new Error("fixture owner mismatch");
    if (input.kind === "status") {
      await holdStatus?.();
      return encrypted.seal(
        signV2ThreadCallbackResponse(input, { active: true }, app.artifact.privateKey),
      );
    }
    if (input.kind !== "proof") throw new Error("fixture callback unsupported");
    await holdProof?.();
    return encrypted.seal(
      signV2ThreadCallbackResponse(
        input,
        {
          signature: sign(
            null,
            Buffer.from(
              JSON.stringify([
                "callback-proof",
                input.ownerDigest,
                input.revision,
                input.expiry,
                input.challenge,
              ]),
            ),
            app.artifact.privateKey,
          ).toString("base64url"),
        },
        app.artifact.privateKey,
      ),
    );
  });
  const base = app.bind("native-0", app.root);
  const host = makeV2ThreadPluginHost(base);
  host.context.session.get = async ({ sessionID }) => {
    const owner = owners.get(sessionID);
    if (!owner) throw new Error("fixture missing");
    return {
      id: sessionID,
      location: { directory: owner.directory },
      metadata: {
        bigbud_provider: "opencodeV2",
        bigbud_thread: owner.threadId,
        bigbud_storage: owner.storageIdentity,
        ...v2NativeRegistrationMetadata({
          registrationFamily: "scoped",
          profileIssuer: owner.issuer,
        }),
      },
    };
  };
  const plugin = (await import(app.artifact.entryUri)).default;
  let dispose = await plugin.setup(host.context);
  function owner(index: number, namespaced: boolean | "compact" = false) {
    const value: V2ThreadOwner = {
      ...base,
      nativeSessionId:
        namespaced === "compact"
          ? v2CompactNativeSessionId(app.artifact.issuer, index.toString(16).padStart(64, "0"))
          : namespaced
            ? `${v2ScopedNativeSessionPrefix(app.artifact.issuer)}${index.toString(16).padStart(64, "0")}`
            : `native-${index}`,
      threadId: `thread-${index}`,
      callbackUrl: transport.url,
      callbackToken: randomBytes(32).toString("hex"),
      enrollmentNonce: randomBytes(16).toString("hex"),
    };
    owners.set(value.nativeSessionId, value);
    return value;
  }
  function envelope(
    material: V2ThreadOwner,
    operation: V2ThreadEnvelope["operation"],
    revision: number | null = null,
    expiry: number | null = null,
  ) {
    return signV2ThreadEnvelope(
      {
        protocol: material.protocol,
        operation,
        issuer: material.issuer,
        ownerDigest: v2ThreadOwnerDigest(material),
        enrollmentNonce: material.enrollmentNonce,
        requestId: randomBytes(16).toString("hex"),
        authExpiresAt: Date.now() + 14000,
        leaseRevision: revision,
        leaseExpiresAt: expiry,
        owner: operation === "enroll" ? material : null,
      },
      app.artifact.privateKey,
    );
  }
  return {
    app,
    host,
    owner,
    envelope,
    async restart() {
      await dispose();
      dispose = await plugin.setup(host.context);
    },
    holdProof: (run?: () => Promise<void>) => {
      holdProof = run;
    },
    holdStatus: (run?: () => Promise<void>) => {
      holdStatus = run;
    },
    async close() {
      await dispose();
      await transport.close();
      await app.close();
    },
  };
}
