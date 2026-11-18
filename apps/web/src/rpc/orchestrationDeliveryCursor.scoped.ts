import type { RemoteBackendIdentityPin } from "@bigbud/shared/remoteBackendIdentity";

export interface NativeDeliveryCursor {
  readonly consumerId: string;
  readonly read: () => number;
  readonly write: (sequence: number) => void;
}

interface CursorStorage {
  readonly session: Pick<Storage, "getItem" | "setItem">;
  readonly local: Pick<Storage, "getItem" | "setItem">;
  readonly randomId: () => string;
}

/** The caller must admit the authenticated authority before constructing its scope.
 * No credential, endpoint or process epoch participates, and legacy cursors are never imported. */
export function createScopedDeliveryCursor(
  identity: RemoteBackendIdentityPin,
  storage: CursorStorage,
): NativeDeliveryCursor {
  const namespace = JSON.stringify([
    "backend-v1",
    identity.authority.authorityId,
    identity.installationFingerprint,
  ]);
  const consumerKey = `bigbud:orchestration-delivery-consumer:${namespace}`;
  let consumerId: string;
  try {
    consumerId = storage.session.getItem(consumerKey)?.trim() || storage.randomId();
    storage.session.setItem(consumerKey, consumerId);
  } catch {
    consumerId = storage.randomId();
  }
  const cursorKey = `bigbud:orchestration-delivery-cursor:${JSON.stringify([namespace, consumerId])}`;
  return {
    consumerId,
    read: () => {
      try {
        const raw = storage.local.getItem(cursorKey);
        if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) return 0;
        const sequence = Number(raw);
        return Number.isSafeInteger(sequence) ? sequence : 0;
      } catch {
        return 0;
      }
    },
    write: (sequence) => {
      if (!Number.isSafeInteger(sequence) || sequence < 0) return;
      try {
        storage.local.setItem(cursorKey, String(sequence));
      } catch {
        // Quota/private mode cannot invalidate the live applied sequence.
      }
    },
  };
}
