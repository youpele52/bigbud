import type { PeerDispatch, PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";

export const COORDINATOR_AUTHORITY = "a".repeat(32);
export const WORKER_AUTHORITY = "c".repeat(32);

export const peerUuid = (prefix: number, n: number): string =>
  `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const peerCeiling = {
  runtimeMode: "auto-accept-edits",
  providers: ["codex", "claudeAgent"],
  workspaceRoots: ["/srv/work"],
} as const satisfies PeerGrant["ceiling"];

export const peerGrantFixture = (n: number, overrides: Partial<PeerGrant> = {}): PeerGrant => ({
  grantId: peerUuid(1, n),
  coordinatorAuthorityId: COORDINATOR_AUTHORITY,
  coordinatorKeyFingerprint: `sha256:${"b".repeat(64)}`,
  workerAuthorityId: WORKER_AUTHORITY,
  actions: ["delegate", "status", "follow", "cancel"],
  ceiling: { ...peerCeiling, providers: ["codex"] },
  issuedAt: `2026-11-18T00:00:0${n}.000Z`,
  expiresAt: "2026-12-18T00:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

export const peerDispatchFixture = (
  n: number,
  overrides: Partial<PeerDispatch> = {},
): PeerDispatch => {
  const dispatchId = peerUuid(2, n);
  return {
    dispatchId,
    commandId: `peer:${COORDINATOR_AUTHORITY}:${dispatchId}`,
    coordinatorAuthorityId: COORDINATOR_AUTHORITY,
    coordinatorThreadId: "thread-coordinator" as PeerDispatch["coordinatorThreadId"],
    requestKey: `invocation-${n}`,
    worker: {
      workerAuthorityId: WORKER_AUTHORITY,
      grantId: peerUuid(1, 1),
      workspaceRoot: "/srv/work",
      provider: "codex",
    },
    permissions: { ...peerCeiling, providers: ["codex"] },
    state: "pending",
    sendAttempts: 0,
    childThreadId: null,
    cancelRequestedAt: null,
    result: null,
    error: null,
    createdAt: `2026-11-18T00:00:0${n}.000Z`,
    updatedAt: `2026-11-18T00:00:0${n}.000Z`,
    ...overrides,
  };
};
