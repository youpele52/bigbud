import { PEER_GRANT_OWNER_PATH } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { WORKER_AUTHORITY } from "../peer-orchestration/peerFixtures.test.helpers.ts";
import { ServerConfig } from "../startup/config.ts";
import { peerGrantOwnerRoute } from "./peerGrantOwnerRoute.ts";
import { makePeerRouteFixture, makePoster, WORKSPACE } from "./peerRoutes.test.helpers.ts";

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) await step();
});

async function ownerRoute() {
  const fixture = await makePeerRouteFixture();
  const config = Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig;
      return { ...base, mode: "remote" as const };
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/tmp/peer-owner", "/tmp/peer-owner").pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  const app = HttpRouter.toWebHandler(
    peerGrantOwnerRoute.pipe(HttpRouter.provideRequest(Layer.mergeAll(fixture.services, config))),
    { disableLogger: true },
  );
  cleanup.push(fixture.dispose, () => app.dispose());
  return { fixture, post: makePoster(app) };
}

const issue = (overrides: Record<string, unknown> = {}) => ({
  action: "issue",
  authorityId: WORKER_AUTHORITY,
  coordinatorAuthorityId: "a".repeat(32),
  coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
  actions: ["delegate", "status", "follow", "cancel"],
  ceiling: { runtimeMode: "approval-required", providers: ["codex"], workspaceRoots: [WORKSPACE] },
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  ...overrides,
});

describe("owner peer grant administration", () => {
  it("issues, supersedes, lists and revokes grants for workspaces this worker has", async () => {
    const { post } = await ownerRoute();
    const first = await post(PEER_GRANT_OWNER_PATH, issue());
    expect(first.status).toBe(200);
    const grant = first.json.grants[0];
    expect(grant.workerAuthorityId).toBe(WORKER_AUTHORITY);
    expect(grant.revokedAt).toBeNull();
    // Re-pairing the same coordinator revokes the previous grant atomically.
    const second = await post(PEER_GRANT_OWNER_PATH, issue());
    expect(second.status).toBe(200);
    const listed = await post(PEER_GRANT_OWNER_PATH, {
      action: "list",
      authorityId: WORKER_AUTHORITY,
    });
    expect(listed.json.grants).toHaveLength(2);
    expect(
      listed.json.grants.filter((entry: { revokedAt: string | null }) => entry.revokedAt === null),
    ).toHaveLength(1);
    const revoked = await post(PEER_GRANT_OWNER_PATH, {
      action: "revoke",
      authorityId: WORKER_AUTHORITY,
      grantId: second.json.grants[0].grantId,
    });
    expect(revoked.json.grants[0].revokedAt).not.toBeNull();
  });

  it("refuses unknown workspaces, other authorities, bad expiry and unknown grants", async () => {
    const { post } = await ownerRoute();
    const refused = async (body: unknown) => (await post(PEER_GRANT_OWNER_PATH, body)).json.refused;
    expect(
      await refused(
        issue({
          ceiling: {
            runtimeMode: "approval-required",
            providers: ["codex"],
            workspaceRoots: ["/srv/not-a-project"],
          },
        }),
      ),
    ).toBe("exceeds-ceiling");
    expect(await refused(issue({ authorityId: "f".repeat(32) }))).toBe("authority-mismatch");
    expect(await refused(issue({ expiresAt: "2020-01-01T00:00:00.000Z" }))).toBe("invalid-request");
    expect(
      await refused(issue({ expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })),
    ).toBe("invalid-request");
    expect(await refused({ ...issue(), extra: 1 })).toBe("invalid-request");
    expect(
      await refused({
        action: "revoke",
        authorityId: WORKER_AUTHORITY,
        grantId: "00000009-0000-4000-8000-000000000009",
      }),
    ).toBe("unknown-grant");
  });
});
