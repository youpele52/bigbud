import { generateKeyPairSync } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { withV2NativeGuardProduction } from "./Subagents.production.fixture.ts";
import {
  NativeFamilyRegistration,
  V2_NATIVE_FAMILY_PROTOCOL,
  nativeFamilyEnvelope,
} from "./Subagents.protocol.ts";

it("real callback transport rejects wrong tokens, stale generations, undeclared children and replayed requests", async () => {
  await withV2NativeGuardProduction(async ({ owner, send, artifact, storage }) => {
    await send("callback-security");
    const stored = storage.get(`root/${owner.native.id}`) as { owner: unknown };
    const registration = Schema.decodeUnknownSync(NativeFamilyRegistration)(stored.owner);
    const crypto = (await import(pathToFileURL(`${artifact.directory}/crypto.mjs`).href)) as {
      sealRequest(value: unknown): { body: unknown };
    };
    const request = {
      protocol: V2_NATIVE_FAMILY_PROTOCOL,
      nonce: registration.nonce,
      rootId: owner.native.id,
      epoch: owner.epoch,
      transportGeneration: registration.transportGeneration,
      generation: owner.family!.generation,
      sessionId: owner.native.id,
      requestNonce: "a".repeat(32),
      expires: Date.now() + 5000,
      kind: "context",
      payload: {
        inputId: owner.family!.admission!.id,
        fingerprint: owner.family!.admission!.fingerprint,
      },
    };
    const post = async (value: unknown, token = registration.callbackToken) =>
      fetch(registration.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(crypto.sealRequest({ token, payload: value }).body),
      });
    expect((await post(request, "f".repeat(64))).status).toBe(403);
    expect(
      (await post({ ...request, requestNonce: "b".repeat(32), generation: request.generation + 1 }))
        .status,
    ).toBe(403);
    expect(
      (await post({ ...request, requestNonce: "c".repeat(32), sessionId: "ses_undeclared" }))
        .status,
    ).toBe(403);
    expect((await post(request)).status).toBe(200);
    expect((await post(request)).status).toBe(403);
  });
});

it("native registration rejects forged RPC signatures and app-marked unguarded child prompts, but leaves unrelated sessions alone", async () => {
  await withV2NativeGuardProduction(async ({ owner, http, send, artifact }) => {
    await send("native-authority");
    const wrongKey = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    await expect(
      http.client.rpc.call({
        rpcID: artifact.rpcID,
        method: "fence",
        location: { directory: owner.native.location.directory },
        input: JSON.parse(
          JSON.stringify(
            nativeFamilyEnvelope(wrongKey, "fence", {
              rootId: owner.native.id,
              nonce: "f".repeat(32),
            }),
          ),
        ),
      }),
    ).rejects.toThrow();
    expect(owner.family!.isFenced).toBe(false);
    http.sessions.set("ses_undeclared", {
      ...owner.native,
      id: "ses_undeclared",
      parentID: owner.native.id,
    });
    http.messages.set("ses_undeclared", []);
    await expect(
      http.client.session.prompt({
        sessionID: "ses_undeclared",
        id: "msg_undeclared",
        text: "must not run",
      }),
    ).rejects.toThrow();
    expect(http.messages.get("ses_undeclared")).toEqual([]);
    http.sessions.set("ses_foreign", { ...owner.native, id: "ses_foreign", metadata: {} });
    http.messages.set("ses_foreign", []);
    await http.client.session.prompt({
      sessionID: "ses_foreign",
      id: "msg_foreign",
      text: "unrelated native user",
    });
    expect(http.messages.get("ses_foreign")!.some((message) => message.id === "msg_foreign")).toBe(
      true,
    );
  });
});

it("emitted native RPC rejects a replayed signed control request", async () => {
  await withV2NativeGuardProduction(async ({ owner, http, send, artifact, storage }) => {
    await send("rpc-replay");
    const registration = Schema.decodeUnknownSync(NativeFamilyRegistration)(
      (storage.get(`root/${owner.native.id}`) as { owner: unknown }).owner,
    );
    const input = JSON.parse(
      JSON.stringify(
        nativeFamilyEnvelope(artifact.privateKey, "inspect", {
          rootId: owner.native.id,
          nonce: registration.nonce,
        }),
      ),
    );
    const call = () =>
      http.client.rpc.call({
        rpcID: artifact.rpcID,
        method: "inspect",
        location: { directory: owner.native.location.directory },
        input,
      });
    await call();
    await expect(call()).rejects.toThrow();
  });
});

it("known native roots and children cannot escape guard authority by removing ownership metadata", async () => {
  await withV2NativeGuardProduction(async ({ owner, http, send, launch, context }) => {
    await send("marker-removal");
    const id = await launch();
    const child = http.sessions.get(id)!;
    http.sessions.set(id, { ...child, metadata: {} });
    await expect(context(id)).rejects.toThrow();
    http.sessions.set(id, child);
    const root = http.sessions.get(owner.native.id)!;
    http.sessions.set(root.id, { ...root, metadata: {} });
    await expect(context(root.id)).rejects.toThrow();
    http.sessions.set(root.id, root);
  });
});

it("implicit native foreground backgrounding retains an exact executor continuation obligation despite model idle", async () => {
  await withV2NativeGuardProduction(
    async ({ runtime, owner, http, send, launch, expectRetainedClose }) => {
      await send("implicit-background");
      const id = await launch(false);
      const child = owner.family!.child(id)!;
      expect(child.executionPending).toBe(false);
      expect(child.continuationPending).toBe(true);
      expect(child.executionReceipt).toMatch(/^[a-f0-9]{64}$/);
      http.sessions.set(id, {
        ...http.sessions.get(id)!,
        outcome: "succeeded",
        time: { created: 10, updated: 20, idle: 21 },
      });
      await runtime.reconcile(owner);
      expect(owner.family!.child(id)!.state).not.toBe("terminal");
      await expect(runtime.interrupt(owner.threadId)).rejects.toThrow("unconfirmed");
      expect(owner.family!.live).toBe(true);
      await expect(send("unsafe-rearm")).rejects.toThrow();
      // Stock evidence cannot settle the obligation, so shutdown keeps reporting it.
      expectRetainedClose("V2 descendant Stop remains unconfirmed");
    },
    "full-access",
    "running",
  );
});
