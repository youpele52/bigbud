import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, sign } from "node:crypto";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { ownV2WindowsFixture } from "./SharedService.windows.fixture.mjs";
import { signV2ThreadCallbackResponse } from "./Orchestration.response.ts";
import { openV2ThreadEncryptedRequest } from "./Orchestration.crypto.ts";
import {
  signV2ThreadEnvelope,
  v2ThreadOwnerDigest,
  V2_ENROLLMENT_PROTOCOL,
  type V2ThreadOwner,
  type V2ThreadEnvelope,
} from "./Orchestration.protocol.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { makeV2LegacyRegistrationFixture } from "./Orchestration.registration.legacy.fixture.ts";

/** App-only challenge/dispatch fixture; never contacts a vendor or real native session. */
export async function makeV2ThreadPluginFixture(
  options: {
    readonly stateRoot?: string;
    readonly invoke?: (value: Record<string, unknown>) => Promise<unknown>;
    readonly responseLease?: () => { readonly revision: number; readonly expiry: number };
    readonly implementationVersion?: "v1" | "v2";
    readonly legacyRegistration?: boolean;
  } = {},
) {
  const parent = path.join(os.tmpdir(), "opencode");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(path.join(parent, "thread-plugin-")));
  await ownV2WindowsFixture(root);
  const preferred = await exportV2ThreadArtifact(options.stateRoot ?? root);
  const artifact = options.legacyRegistration
    ? await makeV2LegacyRegistrationFixture(preferred)
    : preferred;
  let owner: V2ThreadOwner | undefined;
  const state = { active: true, invocations: [] as Record<string, unknown>[] };
  const server = createServer(async (request, response) => {
    if (!owner || request.headers.authorization !== undefined) {
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const encrypted = openV2ThreadEncryptedRequest(
      JSON.parse(Buffer.concat(chunks).toString()),
      artifact.encryptionPrivateKey,
    );
    if (encrypted.token !== owner.callbackToken) {
      response.writeHead(403).end();
      return;
    }
    const body = encrypted.payload as {
      kind: string;
      ownerDigest: string;
      enrollmentNonce: string;
      requestNonce: string;
      leaseRevision: number;
      leaseExpiresAt: number;
      revision: number;
      expiry: number;
      challenge: string;
    };
    let result: unknown;
    if (body.kind === "proof") {
      result = {
        signature: sign(
          null,
          Buffer.from(
            JSON.stringify([
              "callback-proof",
              v2ThreadOwnerDigest(owner),
              body.revision,
              body.expiry,
              body.challenge,
            ]),
          ),
          artifact.privateKey,
        ).toString("base64url"),
      };
    } else if (body.kind === "status") result = { active: state.active };
    else {
      state.invocations.push(body);
      result = options.invoke
        ? await options.invoke(body)
        : { ok: true, result: { delivery: "started" } };
    }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          encrypted.seal(
            signV2ThreadCallbackResponse(
              body,
              result,
              artifact.privateKey,
              body.kind === "proof" ? undefined : options.responseLease?.(),
            ),
          ),
        ),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const port = address.port;
  function bind(nativeSessionId: string, directory: string): V2ThreadOwner {
    owner = {
      protocol: V2_ENROLLMENT_PROTOCOL,
      issuer: artifact.issuer,
      bootstrapDigest: artifact.artifactDigest,
      bootstrapAbi: artifact.bootstrapAbi,
      compatibilityDigest: artifact.compatibilityDigest,
      implementationDigest: v2ThreadImplementation(options.implementationVersion)
        .implementationDigest,
      threadId: "disposable-canonical-thread",
      nativeSessionId,
      storageIdentity: "disposable-storage",
      directory,
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      sessionEpoch: 0,
      transportGeneration: "disposable-transport",
      consentRevision: 1,
      enrollmentNonce: randomBytes(16).toString("hex"),
      callbackUrl: `http://127.0.0.1:${port}/invoke`,
      callbackToken: randomBytes(32).toString("hex"),
    };
    return owner;
  }
  function envelope(
    operation: V2ThreadEnvelope["operation"],
    revision: number | null = null,
    expiry: number | null = null,
  ) {
    if (!owner) throw new Error("fixture owner unavailable");
    return signV2ThreadEnvelope(
      {
        protocol: V2_ENROLLMENT_PROTOCOL,
        operation,
        issuer: artifact.issuer,
        ownerDigest: v2ThreadOwnerDigest(owner),
        enrollmentNonce: owner.enrollmentNonce,
        requestId: randomBytes(16).toString("hex"),
        authExpiresAt: Date.now() + 14000,
        leaseRevision: revision,
        leaseExpiresAt: expiry,
        owner: operation === "enroll" ? owner : null,
      },
      artifact.privateKey,
    );
  }
  return {
    root,
    artifact,
    state,
    bind,
    envelope,
    async closeCallback() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async close() {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
