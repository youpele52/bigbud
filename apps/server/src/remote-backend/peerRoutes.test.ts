import { PEER_ROUTE_PATHS } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import { afterEach, describe, expect, it } from "vitest";

import { peerUuid } from "../peer-orchestration/peerFixtures.test.helpers.ts";
import { authorizeRemoteClientRequest } from "./clientAuthorization.ts";
import { peerActionForRequest, readPeerCredential } from "./peerAuthorization.credential.ts";
import { delegateBody, makePeerRouteFixture, peerHeaders } from "./peerRoutes.test.helpers.ts";

let fixture: Awaited<ReturnType<typeof makePeerRouteFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

describe("worker peer router boundary", () => {
  it("peer_credential_cannot_call_client_rpc", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const credential = peerHeaders(grant);
    // Client RPC, websocket, owner, asset and unknown paths are not mounted on the peer router.
    for (const path of [
      "/ws",
      "/api/remote-backend/handshake",
      "/api/remote-backend/peer-grants",
      "/api/mobile/handshake",
      "/attachments/x",
      "/api/peer/v1/unknown",
      `${PEER_ROUTE_PATHS.status}?token=x`,
    ]) {
      const response = await fixture.post(path, {}, credential);
      expect(response.status, path).toBe(404);
    }
    const upgrade = await fixture.post(
      "/ws",
      undefined,
      { ...credential, upgrade: "websocket" },
      "GET",
    );
    expect(upgrade.status).toBe(404);
    // A peer route with a client bearer, or without the peer credential, never runs a handler.
    const status = { dispatchId: peerUuid(2, 1) };
    expect((await fixture.post(PEER_ROUTE_PATHS.status, status)).status).toBe(403);
    expect(
      (
        await fixture.post(PEER_ROUTE_PATHS.status, status, {
          ...credential,
          authorization: "Bearer client-token",
        })
      ).status,
    ).toBe(403);
    expect((await fixture.post(PEER_ROUTE_PATHS.status, status, credential, "GET")).status).toBe(
      404,
    );
    // The client boundary never accepts the peer credential in place of the client token.
    for (const url of ["/ws", "/api/remote-backend/handshake", PEER_ROUTE_PATHS.delegate])
      expect(
        authorizeRemoteClientRequest({
          method: "POST",
          url,
          headers: { ...credential, "x-bigbud-client-rpc-revision": "1" },
          expectedToken: "client-secret",
        }),
      ).toBe("unauthorized");
    expect(peerActionForRequest("POST", PEER_ROUTE_PATHS.cancel)).toBe("cancel");
    expect(peerActionForRequest("POST", "/ws")).toBeUndefined();
    expect(readPeerCredential({ ...credential, "x-bigbud-peer-grant": "../x" })).toBeUndefined();
  });

  it("revoked_grant_refused", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const accepted = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(1),
      peerHeaders(grant),
    );
    expect(accepted.status).toBe(200);
    await fixture.system.run(
      fixture.repositories.grants.revoke(grant.grantId, new Date().toISOString()),
    );
    for (const [path, body] of [
      [PEER_ROUTE_PATHS.delegate, delegateBody(2)],
      [PEER_ROUTE_PATHS.status, { dispatchId: peerUuid(2, 1) }],
      [PEER_ROUTE_PATHS.follow, { dispatchId: peerUuid(2, 1), waitMs: 0 }],
      [PEER_ROUTE_PATHS.cancel, { dispatchId: peerUuid(2, 1) }],
    ] as const) {
      const refused = await fixture.post(path, body, peerHeaders(grant));
      expect(refused.status, path).toBe(403);
      expect(refused.json.error.code, path).toBe("grant-revoked");
    }
    // Re-pairing supersedes: the old grant stays refused, the new one cannot see old children.
    const next = await fixture.issue(2);
    const unknown = await fixture.post(
      PEER_ROUTE_PATHS.status,
      { dispatchId: peerUuid(2, 1) },
      peerHeaders(next),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.json.error.code).toBe("dispatch-unknown");
  });

  it("expired_grant_refused", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1, {
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-02-01T00:00:00.000Z",
    });
    const refused = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(1),
      peerHeaders(grant),
    );
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("grant-expired");
  });

  it("refuses an unknown grant, a foreign key or coordinator, and a disallowed action", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1, { actions: ["status"] });
    const code = async (
      headers: Record<string, string>,
      path: string = PEER_ROUTE_PATHS.status,
    ) => {
      const response = await fixture!.post(path, { dispatchId: peerUuid(2, 9) }, headers);
      return response.json.error?.code ?? response.status;
    };
    const headers = peerHeaders(grant);
    expect(await code({ ...headers, "x-bigbud-peer-grant": peerUuid(1, 77) })).toBe(
      "grant-missing",
    );
    expect(await code({ ...headers, "x-bigbud-peer-key": `sha256:${"f".repeat(64)}` })).toBe(
      "authority-mismatch",
    );
    expect(await code({ ...headers, "x-bigbud-peer-coordinator": "e".repeat(32) })).toBe(
      "authority-mismatch",
    );
    expect(await code(headers)).toBe("dispatch-unknown");
    expect(await code(headers, PEER_ROUTE_PATHS.cancel)).toBe("action-not-allowed");
    const delegate = await fixture.post(PEER_ROUTE_PATHS.delegate, delegateBody(1), headers);
    expect(delegate.json.error.code).toBe("action-not-allowed");
    // A grant issued for another worker never admits here.
    const foreign = await fixture.issue(3, {
      coordinatorAuthorityId: "f".repeat(32),
      workerAuthorityId: "9".repeat(32),
    });
    expect(await code(peerHeaders(foreign))).toBe("authority-mismatch");
  });

  it("rejects malformed and oversized bodies before admission", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const extra = await fixture.post(
      PEER_ROUTE_PATHS.status,
      { dispatchId: peerUuid(2, 1), extra: true },
      peerHeaders(grant),
    );
    expect(extra.status).toBe(400);
    const huge = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(1, { task: "x".repeat(300_000) }),
      peerHeaders(grant),
    );
    expect(huge.status).toBe(400);
  });
});
