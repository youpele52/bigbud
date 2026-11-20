import type { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import type {
  RemoteRuntimeUpdateAffectedWork,
  RemoteRuntimeUpdateOperation,
  RemoteRuntimeUpdateState,
  RemoteRuntimeUpdateStatus,
} from "@bigbud/contracts/server/remoteBackendUpdate.ts";

export const OPERATION_ID = "11111111-2222-4333-8444-555555555555";
export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);

export const TURN: RemoteRuntimeUpdateAffectedWork = {
  kind: "turn",
  id: "turn-1",
  label: "Refactor billing (Codex)",
};
export const APPROVAL: RemoteRuntimeUpdateAffectedWork = {
  kind: "approval",
  id: "approval-1",
  label: "Approve `rm -rf build`",
};

export function operation(
  state: RemoteRuntimeUpdateState,
  overrides: Partial<RemoteRuntimeUpdateOperation> = {},
): RemoteRuntimeUpdateOperation {
  return {
    operationId: OPERATION_ID,
    version: "0.9.0",
    source: "release",
    state,
    interruptRequested: false,
    consent: "none",
    failure: null,
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:00:00.000Z",
    ...overrides,
  };
}

export function status(
  op: RemoteRuntimeUpdateOperation | null,
  work: ReadonlyArray<RemoteRuntimeUpdateAffectedWork> = [],
  digest: string | null = work.length > 0 ? DIGEST_A : null,
): RemoteRuntimeUpdateStatus {
  return { operation: op, affectedWork: [...work], affectedWorkDigest: digest };
}

export function handshake(runtimeUpdates: boolean, backendVersion = "0.8.0") {
  return {
    handshakeRevision: 1,
    clientRpcRevision: 1,
    authority: {
      authorityId: "a".repeat(32),
      keyEpoch: 1,
      keyFingerprint: `sha256:${"b".repeat(64)}`,
    },
    installationFingerprint: `sha256:${"c".repeat(64)}`,
    backendVersion,
    capabilities: {
      persistentTerminals: false,
      visibleBrowser: false,
      computerUse: false,
      hostOsIntegration: false,
      mobileAccess: false,
      runtimeUpdates,
    },
  } as RemoteBackendClientHandshake;
}

export function typedError(code: string, message = `${code} message`) {
  return { _tag: "RemoteRuntimeUpdateError", code, message };
}
