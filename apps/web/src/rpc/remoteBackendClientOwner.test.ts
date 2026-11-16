import type { RemoteBackendClientHandshake } from "@bigbud/contracts/server/remoteBackendClientHandshake.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWsConnectionStatus } from "./wsConnectionState";
import { openRemoteBackendClientOwner } from "./remoteBackendClientOwner";
import {
  RemoteBackendClientRefused,
  type RemoteEndpointResolver,
} from "./remoteBackendClientEndpoint";
import { MockWebSocket, registerTestHooks, waitFor } from "./wsTransport.test.helpers";
import type { WsTransportScope } from "./wsTransport.scope";

const sockets: MockWebSocket[] = [];
registerTestHooks(sockets, []);
const owners: Awaited<ReturnType<typeof openRemoteBackendClientOwner>>[] = [];
afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner.dispose()));
});
const handshake: RemoteBackendClientHandshake = {
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
const pin = {
  authority: handshake.authority,
  installationFingerprint: handshake.installationFingerprint,
};
const endpoint = { websocketUrl: "ws://127.0.0.1:33299/ws?token=fixture-only", handshake };
function settings() {
  const entries = new Map<string, string>();
  const store = {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
  };
  const scope = {
    reconnectAttempt: () => 0,
    onAttempt: vi.fn(),
    onOpen: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    recordReconnectScheduled: vi.fn(),
    recordProtocolRecovery: vi.fn(),
    trackRpcRequestSent: vi.fn(),
    acknowledgeRpcRequest: vi.fn(),
    clearAllTrackedRpcRequests: vi.fn(),
    markWsInboundActivity: vi.fn(),
    dispose: vi.fn(),
  } satisfies Omit<WsTransportScope, "resolveUrl">;
  return {
    pin,
    signal: new AbortController().signal,
    scope,
    cursorStorage: { session: store, local: store, randomId: () => "fixture-consumer" },
    onDeliveryLifecycle: vi.fn(),
    onAdmissionFailure: vi.fn(),
    resolveEndpoint: vi.fn<RemoteEndpointResolver>(async () => endpoint),
  };
}

describe("admitted remote backend owner assembly", () => {
  it("rejects identity before constructing sockets or touching cursor storage", async () => {
    const config = settings();
    config.resolveEndpoint.mockResolvedValue({
      ...endpoint,
      handshake: { ...handshake, installationFingerprint: `sha256:${"d".repeat(64)}` },
    });
    await expect(openRemoteBackendClientOwner(config)).rejects.toMatchObject({
      status: "duplicate-authority",
    });
    expect(config.scope.dispose).toHaveBeenCalledOnce();
    expect(config.cursorStorage.local.getItem).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  it.each([
    "ws://public.invalid/ws",
    "https://127.0.0.1/ws",
    "wss://user:password@host.invalid/ws",
    "wss://host.invalid/ws#secret",
  ])("rejects unsafe endpoint without reflecting credentials: %s", async (websocketUrl) => {
    const config = settings();
    config.resolveEndpoint.mockResolvedValue({ ...endpoint, websocketUrl });
    await expect(openRemoteBackendClientOwner(config)).rejects.toEqual(
      new RemoteBackendClientRefused("invalid-endpoint"),
    );
    expect(sockets).toHaveLength(0);
    expect(config.scope.dispose).toHaveBeenCalledOnce();
  });

  it("rechecks the pin on reconnect and fences the owner before a changed key can accept RPC", async () => {
    const config = settings();
    config.resolveEndpoint.mockResolvedValueOnce(endpoint).mockResolvedValue({
      ...endpoint,
      handshake: {
        ...handshake,
        authority: {
          ...handshake.authority,
          keyEpoch: 2,
          keyFingerprint: `sha256:${"d".repeat(64)}`,
        },
      },
    });
    const pinWithUnknownFields = {
      ...config.pin,
      authority: { ...config.pin.authority, privateExtra: "fixture-only" },
    };
    const owner = await openRemoteBackendClientOwner({ ...config, pin: pinWithUnknownFields });
    owners.push(owner);
    expect(owner.identity.authority).not.toHaveProperty("privateExtra");
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    await owner.reconnect();
    await waitFor(() => expect(owner.admissionFailure).toBe("key-rotated"));
    await waitFor(() => expect(config.scope.dispose).toHaveBeenCalledOnce());
    expect(config.resolveEndpoint).toHaveBeenCalledTimes(2);
    expect(config.onAdmissionFailure).toHaveBeenCalledWith("key-rotated");
    expect(sockets).toHaveLength(1);
    await expect(owner.api.server.getConfig()).rejects.toThrow("Transport disposed");
    expect(getWsConnectionStatus()).toMatchObject({ phase: "idle", hasConnected: false });
    expect(Object.isFrozen(owner.identity.authority)).toBe(true);
  });

  it("cancels unresolved authentication without creating a client or cursor", async () => {
    const config = settings();
    const controller = new AbortController();
    let resolverSignal: AbortSignal | undefined;
    config.resolveEndpoint.mockImplementation((signal) => {
      resolverSignal = signal;
      return new Promise(() => {});
    });
    const opening = openRemoteBackendClientOwner({ ...config, signal: controller.signal });
    void opening.catch(() => undefined);
    await waitFor(() => expect(resolverSignal).toBeDefined());
    controller.abort();
    await expect(opening).rejects.toBeDefined();
    expect(resolverSignal?.aborted).toBe(true);
    expect(config.scope.dispose).toHaveBeenCalledOnce();
    expect(config.cursorStorage.local.getItem).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });
});
