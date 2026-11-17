import type { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import type { RemoteBackendRelayLease } from "@bigbud/contracts/server/remoteBackendRelay.ts";
import { vi } from "vitest";
import type { BackendScopeDeps } from "./backendScope";

export const LEASE_ORIGIN = "http://127.0.0.1:41234";
export const LEASE_CREDENTIAL = "e".repeat(64);

export const handshake: RemoteBackendClientHandshake = {
  handshakeRevision: 1,
  clientRpcRevision: 1,
  authority: {
    authorityId: "a".repeat(32),
    keyEpoch: 1,
    keyFingerprint: `sha256:${"b".repeat(64)}`,
  },
  installationFingerprint: `sha256:${"c".repeat(64)}`,
  backendVersion: "0.1.0",
  capabilities: {
    persistentTerminals: false,
    visibleBrowser: false,
    computerUse: false,
    hostOsIntegration: false,
    mobileAccess: false,
    runtimeUpdates: false,
  },
};

export const profile = {
  profileId: "vps-1",
  label: "Build VPS",
  identity: {
    authority: handshake.authority,
    installationFingerprint: handshake.installationFingerprint,
  },
};

let leaseCounter = 0;
export function makeLease(port = 41234): RemoteBackendRelayLease {
  leaseCounter += 1;
  return {
    leaseId: `12345678-1234-4123-8123-${String(leaseCounter).padStart(12, "0")}`,
    profileId: profile.profileId,
    baseUrl: `http://127.0.0.1:${port}`,
    localCredential: LEASE_CREDENTIAL,
  };
}

/** Test double for the existing relay-lease contract (relay profiles are refused in production
 * until WP-3A adds a persisted profile producer). */
export function fakeRelayControl() {
  const relay = {
    listRemoteBackendRelayProfiles: vi.fn(async () => ({
      availability: "available" as const,
      profiles: [profile],
    })),
    openRemoteBackendRelay: vi.fn(async (_input: { profileId: string; requestId: string }) =>
      makeLease(),
    ),
    closeRemoteBackendRelay: vi.fn(async (_input: object) => ({ closed: true })),
  };
  return { relay, dispose: vi.fn(async () => undefined) };
}

export function handshakeFetch(body: unknown = handshake) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) =>
    Response.json(body, { status: 200 }),
  );
}

export function fakeCursorStorage() {
  const entries = new Map<string, string>();
  const store = {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
  };
  return { entries, storage: { session: store, local: store, randomId: () => "consumer" } };
}

export function scopeDeps(
  overrides: Partial<BackendScopeDeps> & { readonly control?: ReturnType<typeof fakeRelayControl> },
) {
  const control = overrides.control ?? fakeRelayControl();
  const cursor = fakeCursorStorage();
  const disposers: Array<() => void> = [];
  const deps: Partial<BackendScopeDeps> = {
    search: "?backend=vps-1",
    openRelayControl: () => control,
    fetch: handshakeFetch() as unknown as typeof fetch,
    randomId: () => "12345678-1234-4123-8123-abcdefabcdef",
    cursorStorage: () => cursor.storage,
    onDeliveryLifecycle: vi.fn(),
    bindAssets: vi.fn(),
    onUnload: (dispose) => disposers.push(dispose),
    ...overrides,
  };
  return { control, cursor, disposers, deps };
}
