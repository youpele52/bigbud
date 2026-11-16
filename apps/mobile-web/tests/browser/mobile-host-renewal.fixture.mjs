import assert from "node:assert/strict";
import { HOSTED, HOSTS, installHostAccessRoutes } from "./mobile-host-access.routes.mjs";

/** Disposable SAME full-pin/origin renewal only; no production readiness or real credentials. */
export async function setupHostRenewal(page, localOrigin, data) {
  const sessions = structuredClone(data.hostAccessSessions);
  const rpcOwners = [];
  const state = await installHostAccessRoutes(page, {
    localOrigin,
    appOrigin: HOSTED,
    config: data.hostAccessConfig,
    descriptors: data.hostAccessDescriptors,
    sessions,
    onRpcRequest({ host, request, record }) {
      record.sessionId ??= sessions[host].sessionId;
      record.scope ??= sessions[host].scope;
      rpcOwners.push({
        host,
        sessionId: record.sessionId,
        scope: record.scope,
        tag: request.tag,
        ...(request.payload?.commandId ? { commandId: request.payload.commandId } : {}),
      });
      return false;
    },
  });
  await page.addInitScript(() => {
    const sockets = [];
    globalThis.__mobileRenewalSockets = sockets;
    const NativeWebSocket = WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        sockets.push(this);
      }
    };
  });
  return { state, sessions, rpcOwners };
}

export async function navigateRenewal(page, strict) {
  const url = `${HOSTED}/mobile/pair/fixture-pair-A?backend=${encodeURIComponent(HOSTS.A)}&fixtureStrict=${strict ? "1" : "0"}#secret=fixture-secret-A`;
  await page.evaluate((next) => {
    history.pushState({}, "", next);
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, url);
  await page
    .getByRole("button", { name: "Confirm pairing", exact: true })
    .waitFor({ timeout: 30000 });
}

/** Retain the original active native object while its actual held dispatch is observed. */
export async function retainRenewalSocket(page) {
  await page.evaluate(
    (origin) => {
      const active = globalThis.__mobileRenewalSockets.filter(
        (candidate) =>
          new URL(candidate.url).origin === origin && candidate.readyState === WebSocket.OPEN,
      );
      if (active.length !== 1)
        throw new Error(
          "Expected one original active renewal socket: " +
            JSON.stringify({
              expectedOrigin: origin,
              open: WebSocket.OPEN,
              sockets: globalThis.__mobileRenewalSockets.map((socket) => ({
                origin: new URL(socket.url).origin,
                readyState: socket.readyState,
              })),
            }),
        );
      globalThis.__mobileHeldRenewalSocket = active[0];
    },
    HOSTS.A.replace("https:", "wss:"),
  );
}

/** Already-queued native callback simulation, explicitly not live transport after close. */
export async function deliverRetiredRenewalExit(page, held) {
  await page.waitForFunction(
    () => globalThis.__mobileHeldRenewalSocket?.readyState === WebSocket.CLOSED,
    undefined,
    { timeout: 5000 },
  );
  return page.evaluate(
    ({ requestId }) => {
      const socket = globalThis.__mobileHeldRenewalSocket;
      if (!socket || socket.readyState !== WebSocket.CLOSED)
        throw new Error("Expected the actual retired old-session WebSocket");
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            _tag: "Exit",
            requestId,
            exit: { _tag: "Success", value: { sequence: 999 } },
          }),
        }),
      );
      return { retiredSocket: true, queuedCallbackSimulation: true };
    },
    { requestId: held.request.id },
  );
}

export function assertRenewalClean(owned) {
  assert.deepEqual(owned.state.errors, []);
  assert.deepEqual(owned.state.rejected, []);
  assert.deepEqual(owned.state.hmr, []);
}
