import { afterEach, describe, expect, it, vi } from "vitest";
import { remoteBackendWindowGuidance } from "../components/remote-backend/remoteBackendWindow.logic";
import { toAttachmentPreviewUrl } from "../lib/attachmentPreview";
import {
  __resetBackendScopedStorageForTests,
  backendScopedKey,
  backendStoragePrefix,
} from "../lib/backendScopedStorage";
import { bootstrapBackendScope } from "./backendScope";
import {
  __resetBackendScopeForTests,
  BoundBackendNotReadyError,
  readBackendScope,
  readBoundBackendHandshake,
  setBackendScope,
} from "./backendScope.state";
import {
  fakeRelayControl,
  handshake,
  handshakeFetch,
  LEASE_CREDENTIAL,
  LEASE_ORIGIN,
  profile,
  scopeDeps,
} from "./backendScope.test.helpers";
import { __resetNativeApiForTests, readNativeApi } from "./nativeApi";
import { createWsNativeApi } from "./wsNativeApi";
import { resolveWsHttpOrigin, resolveWsHttpRequestHeaders } from "./wsHttpOrigin";
import { getWsRpcClient } from "./wsRpcClient";
import { MockWebSocket, registerTestHooks, waitFor } from "./wsTransport.test.helpers";

const sockets: MockWebSocket[] = [];
registerTestHooks(sockets, []);
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  __resetBackendScopeForTests();
  __resetBackendScopedStorageForTests();
  __resetNativeApiForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

async function bindWindow(overrides: Parameters<typeof scopeDeps>[0] = {}) {
  const harness = scopeDeps(overrides);
  const state = await bootstrapBackendScope(harness.deps);
  disposers.push(...harness.disposers);
  return { ...harness, state };
}

describe("backend scope binding", () => {
  it("bound_window_never_touches_local_singleton", async () => {
    const control = fakeRelayControl();
    let releaseList!: () => void;
    const listed = control.relay.listRemoteBackendRelayProfiles.getMockImplementation()!;
    control.relay.listRemoteBackendRelayProfiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseList = () => resolve(listed());
        }),
    );
    const harness = scopeDeps({ control });
    const binding = bootstrapBackendScope(harness.deps);
    // While binding, the window is fenced: no local client, API or socket is ever constructed.
    expect(readBackendScope()).toEqual({ kind: "binding", profileId: "vps-1" });
    expect(() => getWsRpcClient()).toThrow(BoundBackendNotReadyError);
    expect(readNativeApi()).toBeUndefined();
    expect(() => createWsNativeApi()).toThrow("no local native API");
    expect(sockets).toHaveLength(0);
    releaseList();
    const state = await binding;
    disposers.push(...harness.disposers);

    expect(state).toMatchObject({ kind: "bound", profileId: "vps-1", label: "Build VPS" });
    // The update UI reads capabilities from the admitted handshake, never from the local backend.
    expect(readBoundBackendHandshake()).toEqual(handshake);
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socketUrl = new URL(sockets[0]!.url);
    expect(socketUrl.origin).toBe(LEASE_ORIGIN.replace("http:", "ws:"));
    expect(socketUrl.pathname).toBe("/ws");
    expect(socketUrl.searchParams.get("token")).toBe(LEASE_CREDENTIAL);
    expect(socketUrl.searchParams.get("clientRpcRevision")).toBe("1");
    // Direct RPC callers and the native API both resolve to the owned remote client.
    const api = readNativeApi();
    expect(api).toBeDefined();
    const client = getWsRpcClient();
    expect(client).toBe(getWsRpcClient());
    expect(() => createWsNativeApi()).toThrow("no local native API");
    // A local fallback would open a second socket to the renderer/local backend origin.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sockets.map((socket) => new URL(socket.url).origin)).toEqual(["ws://127.0.0.1:41234"]);
    // Delivery cursors live under the backend-scoped namespace, never the legacy local keys.
    const keys = harness.cursor.storage.session.setItem.mock.calls.map(([key]) => key);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toContain("backend-v1");
    // Persisted stores share the cursor's pinned identity namespace (WP-3C).
    expect(backendScopedKey("k")).toBe(`${backendStoragePrefix(profile.identity)}k`);
    expect(control.relay.openRemoteBackendRelay).toHaveBeenCalledWith({
      profileId: "vps-1",
      requestId: "12345678-1234-4123-8123-abcdefabcdef",
    });
  });

  it("leaves a window without ?backend= on the local singleton", async () => {
    const harness = scopeDeps({ search: "" });
    const opened = vi.fn(harness.deps.openRelayControl!);
    expect(await bootstrapBackendScope({ ...harness.deps, openRelayControl: opened })).toEqual({
      kind: "local",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(getWsRpcClient()).toBe(getWsRpcClient());
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(new URL(sockets[0]!.url).origin).toBe("ws://localhost:3020");
    expect(resolveWsHttpOrigin()).toBe("http://localhost:3020");
    expect(resolveWsHttpRequestHeaders()).toEqual({});
  });

  it("admission_refusal_shows_update_guidance", async () => {
    const control = fakeRelayControl();
    const { state } = await bindWindow({
      control,
      fetch: handshakeFetch({ ...handshake, clientRpcRevision: 2 }) as unknown as typeof fetch,
    });
    expect(state).toEqual({ kind: "refused", profileId: "vps-1", refusal: "unsupported-revision" });
    expect(sockets).toHaveLength(0);
    expect(readNativeApi()).toBeUndefined();
    expect(() => getWsRpcClient()).toThrow(BoundBackendNotReadyError);
    await waitFor(() => expect(control.dispose).toHaveBeenCalledOnce());
    const leaseId = (await control.relay.openRemoteBackendRelay.mock.results[0]!.value).leaseId;
    expect(control.relay.closeRemoteBackendRelay).toHaveBeenCalledWith({ leaseId });
    const guidance = remoteBackendWindowGuidance(
      state as Extract<typeof state, { kind: "refused" }>,
    );
    expect(guidance).toMatchObject({ tone: "error", title: "Update required", retry: true });
    expect(guidance.description).toContain("Update both to the same bigbud release");
  });

  it("asset_urls_route_to_lease_origin", async () => {
    const { deps, state } = await bindWindow();
    expect(state.kind).toBe("bound");
    expect(resolveWsHttpOrigin()).toBe(LEASE_ORIGIN);
    expect(toAttachmentPreviewUrl("/attachments/a%20b")).toBe(`${LEASE_ORIGIN}/attachments/a%20b`);
    expect(resolveWsHttpRequestHeaders()).toEqual({
      authorization: `Bearer ${LEASE_CREDENTIAL}`,
      "x-bigbud-client-rpc-revision": "1",
    });
    expect(deps.bindAssets).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: LEASE_ORIGIN, localCredential: LEASE_CREDENTIAL }),
    );
    const [handshakeUrl, init] = (deps.fetch as ReturnType<typeof handshakeFetch>).mock.calls[0]!;
    expect(String(handshakeUrl)).toBe(`${LEASE_ORIGIN}/api/remote-backend/handshake`);
    expect(init?.headers).toEqual({ authorization: `Bearer ${LEASE_CREDENTIAL}` });
  });

  it("a bound window never derives asset URLs from the local backend before binding", () => {
    setBackendScope({ kind: "binding", profileId: "vps-1" });
    expect(resolveWsHttpOrigin()).toBe("");
    expect(resolveWsHttpRequestHeaders()).toEqual({});
  });

  it.each([
    ["setup-required", { availability: "setup-required" as const, profiles: [] }],
    ["not-found", { availability: "available" as const, profiles: [] }],
  ])("reports a typed %s window without opening a lease", async (reason, listing) => {
    const control = fakeRelayControl();
    control.relay.listRemoteBackendRelayProfiles.mockResolvedValue(listing as never);
    const { state } = await bindWindow({ control });
    expect(state).toEqual({ kind: "unavailable", profileId: "vps-1", reason });
    expect(control.relay.openRemoteBackendRelay).not.toHaveBeenCalled();
    expect(control.dispose).toHaveBeenCalledOnce();
  });

  it("rejects a malformed profile ID before any relay traffic", async () => {
    const control = fakeRelayControl();
    const { state } = await bindWindow({ control, search: "?backend=..%2Fx" });
    expect(state).toEqual({ kind: "unavailable", profileId: "../x", reason: "invalid-profile" });
    expect(control.relay.listRemoteBackendRelayProfiles).not.toHaveBeenCalled();
  });
});
