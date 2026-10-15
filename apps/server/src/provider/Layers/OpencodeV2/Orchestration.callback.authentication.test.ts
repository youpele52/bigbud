import { createServer } from "node:http";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { openV2ThreadEncryptedRequest } from "./Orchestration.crypto.ts";
import { signV2ThreadCallbackResponse } from "./Orchestration.response.ts";
import { v2ThreadOwnerDigest } from "./Orchestration.protocol.ts";
import { decodeV2ThreadCallback } from "./Orchestration.callback.ts";

const unchanged = (value: Record<string, unknown>) => value;

it("even decryptable replies must bind the fresh challenge, exact request/result, owner and acknowledged lease", async () => {
  const app = await makeV2ThreadPluginFixture();
  let mutation: (reply: Record<string, unknown>) => Record<string, unknown> = unchanged;
  let captured: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const encrypted = openV2ThreadEncryptedRequest(
      JSON.parse(Buffer.concat(chunks).toString()),
      app.artifact.encryptionPrivateKey,
    );
    const input = decodeV2ThreadCallback(encrypted.payload);
    const signed = signV2ThreadCallbackResponse(
      encrypted.payload as typeof input,
      { active: true },
      app.artifact.privateKey,
    );
    captured ??= signed;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(encrypted.seal(mutation(signed))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture port unavailable");
    const owner = {
      ...app.bind("owned", app.root),
      callbackUrl: `http://127.0.0.1:${address.port}/invoke`,
    };
    const identity = await import(new URL("identity.mjs", app.artifact.entryUri).href);
    const lease = { revision: 1, expiry: Date.now() + 55000 };
    const invoke = () =>
      identity.callback(
        owner,
        {
          kind: "status",
          ownerDigest: v2ThreadOwnerDigest(owner),
          enrollmentNonce: owner.enrollmentNonce,
        },
        new AbortController().signal,
        5000,
        lease,
      );
    expect(await invoke()).toEqual({ active: true });
    for (const change of [
      () => captured!,
      (value: Record<string, unknown>) => ({ ...value, result: { active: false } }),
      (value: Record<string, unknown>) => ({ ...value, operation: "invoke" }),
      (value: Record<string, unknown>) => ({ ...value, ownerDigest: "f".repeat(64) }),
      (value: Record<string, unknown>) => ({ ...value, enrollmentNonce: "f".repeat(32) }),
      (value: Record<string, unknown>) => ({ ...value, requestDigest: "f".repeat(64) }),
      (value: Record<string, unknown>) => ({ ...value, acknowledgedRevision: 2 }),
      (value: Record<string, unknown>) => ({ ...value, acknowledgedExpiry: lease.expiry + 1 }),
    ]) {
      mutation = change;
      await expect(invoke()).rejects.toThrow("Required bigbud thread-tools integration rejected.");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  }
});
