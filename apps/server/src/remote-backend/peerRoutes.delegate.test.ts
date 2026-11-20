import { CommandId } from "@bigbud/contracts";
import { PEER_ROUTE_PATHS } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import { afterEach, describe, expect, it } from "vitest";

import { peerUuid } from "../peer-orchestration/peerFixtures.test.helpers.ts";
import {
  delegateBody,
  makePeerRouteFixture,
  peerHeaders,
  WORKSPACE,
} from "./peerRoutes.test.helpers.ts";

let fixture: Awaited<ReturnType<typeof makePeerRouteFixture>> | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

const readModel = () => fixture!.system.run(fixture!.system.engine.getReadModel());

describe("worker peer delegate", () => {
  it("duplicate_delegate_one_child", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const headers = peerHeaders(grant);
    const first = await fixture.post(PEER_ROUTE_PATHS.delegate, delegateBody(1), headers);
    expect(first.status).toBe(200);
    expect(first.json.replayed).toBe(false);
    const commandId = `peer:${grant.coordinatorAuthorityId}:${peerUuid(2, 1)}`;
    expect(first.json.commandId).toBe(commandId);
    // Concurrent and sequential repeats of the same identity join the same child.
    const repeats = await Promise.all(
      [0, 1, 2].map(() => fixture!.post(PEER_ROUTE_PATHS.delegate, delegateBody(1), headers)),
    );
    for (const repeat of repeats) {
      expect(repeat.status).toBe(200);
      expect(repeat.json.replayed).toBe(true);
      expect(repeat.json.childThreadId).toBe(first.json.childThreadId);
    }
    const children = (await readModel()).threads.filter((thread) => thread.title === "Delegated 1");
    expect(children.map((thread) => thread.id)).toEqual([first.json.childThreadId]);
    // The child-creating command carries the namespaced id; receipts committed it exactly once.
    const events = await fixture.system.run(
      fixture.system.engine.readEventsByCommandId!(CommandId.makeUnsafe(commandId)),
    );
    expect(events.filter((event) => event.type === "thread.created")).toHaveLength(1);
    // The same identity with a different request is a conflict, never a second child.
    const conflict = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(1, { task: "Something else." }),
      headers,
    );
    expect(conflict.status).toBe(409);
    expect(conflict.json.error.code).toBe("dispatch-conflict");
    expect(
      (await readModel()).threads.filter((thread) => thread.title === "Delegated 1"),
    ).toHaveLength(1);
    // The worker records which grant created the child.
    const record = await fixture.system.run(
      fixture.repositories.children.findForGrant(grant.grantId, commandId),
    );
    expect(record?.childThreadId).toBe(first.json.childThreadId);
    expect(record?.grantId).toBe(grant.grantId);
  });

  it("narrower_permissions_enforced", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const headers = peerHeaders(grant);
    const refused = async (n: number, overrides: Record<string, unknown>) => {
      const response = await fixture!.post(
        PEER_ROUTE_PATHS.delegate,
        delegateBody(n, overrides),
        headers,
      );
      expect(response.status).toBe(403);
      return response.json.error.code;
    };
    const permissions = delegateBody(0).permissions;
    // Wider than the grant ceiling in each dimension.
    expect(await refused(2, { permissions: { ...permissions, runtimeMode: "full-access" } })).toBe(
      "permission-exceeds-ceiling",
    );
    expect(
      await refused(3, { permissions: { ...permissions, providers: ["codex", "claudeAgent"] } }),
    ).toBe("permission-exceeds-ceiling");
    expect(
      await refused(4, {
        permissions: { ...permissions, workspaceRoots: [WORKSPACE, "/srv/other"] },
      }),
    ).toBe("permission-exceeds-ceiling");
    // A target outside the request's own (narrower) permissions.
    expect(await refused(5, { provider: "claudeAgent" })).toBe("permission-exceeds-ceiling");
    expect(await refused(6, { workspaceRoot: "/srv/other" })).toBe("permission-exceeds-ceiling");
    expect(
      (await readModel()).threads.filter((thread) => thread.title.startsWith("Delegated")),
    ).toEqual([]);
    // Within the ceiling: the child runs with the narrower runtime mode, never the worker's own.
    const accepted = await fixture.post(PEER_ROUTE_PATHS.delegate, delegateBody(7), headers);
    expect(accepted.status).toBe(200);
    const child = (await readModel()).threads.find(
      (thread) => thread.id === accepted.json.childThreadId,
    );
    expect(child?.runtimeMode).toBe("approval-required");
    expect(child?.modelSelection.provider).toBe("codex");
  });

  it("status, follow and cancel only reach children created under the caller's grant", async () => {
    fixture = await makePeerRouteFixture();
    const grant = await fixture.issue(1);
    const other = await fixture.issue(2, { coordinatorAuthorityId: "e".repeat(32) });
    const created = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(1),
      peerHeaders(grant),
    );
    expect(created.status).toBe(200);
    const ref = { dispatchId: peerUuid(2, 1) };
    for (const [path, body] of [
      [PEER_ROUTE_PATHS.status, ref],
      [PEER_ROUTE_PATHS.follow, { ...ref, waitMs: 0 }],
      [PEER_ROUTE_PATHS.cancel, ref],
    ] as const) {
      const foreign = await fixture.post(path, body, peerHeaders(other));
      expect(foreign.status, path).toBe(404);
      expect(foreign.json.error.code, path).toBe("dispatch-unknown");
    }
    const status = await fixture.post(PEER_ROUTE_PATHS.status, ref, peerHeaders(grant));
    expect(status.status).toBe(200);
    expect(status.json.childThreadId).toBe(created.json.childThreadId);
    expect(["running", "waiting"]).toContain(status.json.state);
    expect(status.json.result).toBeNull();
    const startedAt = Date.now();
    const followed = await fixture.post(
      PEER_ROUTE_PATHS.follow,
      { ...ref, waitMs: 300 },
      peerHeaders(grant),
    );
    expect(followed.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    const cancelled = await fixture.post(PEER_ROUTE_PATHS.cancel, ref, peerHeaders(grant));
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.cancelRequested).toBe(true);
    const again = await fixture.post(PEER_ROUTE_PATHS.cancel, ref, peerHeaders(grant));
    expect(again.status).toBe(200);
    const record = await fixture.system.run(
      fixture.repositories.children.findForGrant(
        grant.grantId,
        `peer:${grant.coordinatorAuthorityId}:${ref.dispatchId}`,
      ),
    );
    expect(record?.cancelRequestedAt).not.toBeNull();
    // An unknown workspace is typed, not a generic failure.
    const missing = await fixture.post(
      PEER_ROUTE_PATHS.delegate,
      delegateBody(9, {
        workspaceRoot: "/srv/missing",
        permissions: {
          runtimeMode: "approval-required",
          providers: ["codex"],
          workspaceRoots: ["/srv/missing"],
        },
      }),
      peerHeaders(
        await fixture.issue(3, {
          coordinatorAuthorityId: "d".repeat(32),
          ceiling: {
            runtimeMode: "approval-required",
            providers: ["codex"],
            workspaceRoots: ["/srv/missing"],
          },
        }),
      ),
    );
    expect(missing.status).toBe(422);
    expect(missing.json.error.code).toBe("workspace-unavailable");
  });
});
