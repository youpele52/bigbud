import { WS_METHODS } from "@bigbud/contracts";
import type { DesktopBridge } from "@bigbud/contracts/server/ipc.ts";
import { describe, expect, it, vi } from "vitest";
import { getWsConnectionStatus } from "./wsConnectionState";
import { getWsInboundActivitySequence } from "./wsActivity";
import { createWsConnectionControls } from "./protocol";
import { WsTransport } from "./wsTransport";
import type { WsTransportScope } from "./wsTransport.scope";
import {
  MockWebSocket,
  createTransport,
  registerTestHooks,
  waitFor,
} from "./wsTransport.test.helpers";

const sockets: MockWebSocket[] = [];
const transports: WsTransport[] = [];
registerTestHooks(sockets, transports);

function owner(url: string) {
  return {
    resolveUrl: vi.fn(async () => url),
    reconnectAttempt: () => 9,
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
  } satisfies WsTransportScope;
}

describe("explicit backend transport scope", () => {
  it("isolates actual socket requests/reconnect/disposal and never consults local desktop readiness", async () => {
    const localReady = vi.fn(() => {
      throw new Error("local readiness must not be used");
    });
    window.desktopBridge = {
      getBackendStartupState: localReady,
      onBackendStartupState: vi.fn(),
    } as unknown as DesktopBridge;
    const a = owner("ws://backend-a.invalid/ws");
    const b = owner("ws://backend-b.invalid/ws");
    const openedA = vi.fn();
    const first = createTransport(
      transports,
      undefined,
      { onOpen: openedA },
      createWsConnectionControls(),
      a,
    );
    const second = createTransport(
      transports,
      undefined,
      undefined,
      createWsConnectionControls(),
      b,
    );
    const requestA = first.request((client) => client[WS_METHODS.serverPing]({}));
    const requestB = second.request((client) => client[WS_METHODS.serverPing]({}));
    await waitFor(() => expect(sockets).toHaveLength(2));
    const socketA = sockets.find((x) => x.url.includes("backend-a"))!;
    const socketB = sockets.find((x) => x.url.includes("backend-b"))!;
    socketA.open();
    socketB.open();
    await waitFor(() => {
      expect(socketA.sent).toHaveLength(1);
      expect(socketB.sent).toHaveLength(1);
    });
    const messageA = JSON.parse(socketA.sent[0]!);
    const messageB = JSON.parse(socketB.sent[0]!);
    expect(a.trackRpcRequestSent).toHaveBeenCalledWith(messageA.id, WS_METHODS.serverPing);
    expect(b.trackRpcRequestSent).toHaveBeenCalledWith(messageB.id, WS_METHODS.serverPing);
    socketA.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: messageA.id,
        exit: { _tag: "Success", value: { serverTime: "2026-11-16T00:00:00.000Z" } },
      }),
    );
    await expect(requestA).resolves.toHaveProperty("serverTime");
    expect(a.acknowledgeRpcRequest).toHaveBeenCalledWith(messageA.id);
    expect(b.acknowledgeRpcRequest).not.toHaveBeenCalled();
    socketB.serverMessage(
      JSON.stringify({
        _tag: "Exit",
        requestId: messageB.id,
        exit: { _tag: "Success", value: { serverTime: "2026-11-16T00:00:00.000Z" } },
      }),
    );
    await requestB;
    expect(openedA).toHaveBeenCalledWith({ reconnectAttempt: 9 });
    await first.reconnect();
    expect(a.clearAllTrackedRpcRequests).toHaveBeenCalledOnce();
    expect(b.clearAllTrackedRpcRequests).not.toHaveBeenCalled();
    await first.dispose();
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(b.dispose).not.toHaveBeenCalled();
    expect(localReady).not.toHaveBeenCalled();
    expect(getWsConnectionStatus()).toMatchObject({ phase: "idle", hasConnected: false });
  });

  it("routes finite-stream activity to its owner and cancels unresolved readiness on disposal", async () => {
    const { Stream } = await import("effect");
    const a = owner("ws://backend-a.invalid/ws");
    const transport = createTransport(
      transports,
      undefined,
      undefined,
      createWsConnectionControls(),
      a,
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.open();
    const baselineActivity = getWsInboundActivitySequence();
    const values: string[] = [];
    await transport.requestStream(
      () => Stream.make("one", "two"),
      (value) => {
        values.push(value);
      },
    );
    expect(values).toEqual(["one", "two"]);
    expect(a.markWsInboundActivity).toHaveBeenCalledTimes(2);
    expect(getWsInboundActivitySequence()).toBe(baselineActivity);
    let release!: (url: string) => void;
    const pendingOwner = {
      ...owner("unused"),
      resolveUrl: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const pending = createTransport(
      transports,
      undefined,
      undefined,
      createWsConnectionControls(),
      pendingOwner,
    );
    await waitFor(() => expect(pendingOwner.resolveUrl).toHaveBeenCalledOnce());
    await pending.dispose();
    release("ws://late-backend.invalid/ws");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sockets).toHaveLength(1);
    expect(pendingOwner.dispose).toHaveBeenCalledOnce();
  });
  it("never enters an owner resolver after disposal while a previous upgrade is settling", async () => {
    const scoped = owner("ws://retired-backend.invalid/ws");
    const controls = createWsConnectionControls();
    let release!: () => void;
    vi.spyOn(controls.upgradeGate, "whenSettled").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const transport = createTransport(transports, undefined, undefined, controls, scoped);
    await waitFor(() => expect(controls.upgradeGate.whenSettled).toHaveBeenCalledOnce());
    expect(scoped.resolveUrl).not.toHaveBeenCalled();
    await transport.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(scoped.resolveUrl).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });
});
