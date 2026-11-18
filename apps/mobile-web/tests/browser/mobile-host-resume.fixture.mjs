import assert from "node:assert/strict";
import { HOSTS, HOSTED, installHostAccessRoutes } from "./mobile-host-access.routes.mjs";

export const RESUME_SEQUENCES = { A: 111, B: 222 };

/** Fictional transport policy only; production hooks still own every reconnect and receipt. */
export async function setupHostResume(page, localOrigin, data) {
  const unavailable = new Set();
  const accepted = new Set();
  const recoveryRequests = [];
  const subscriptions = [];
  const outcomes = [];
  const state = await installHostAccessRoutes(page, {
    localOrigin,
    appOrigin: HOSTED,
    config: data.hostAccessConfig,
    descriptors: data.hostAccessDescriptors,
    sessions: data.hostAccessSessions,
    recoverySequences: RESUME_SEQUENCES,
    allowSocket: (host) => !unavailable.has(host),
    onRpcRequest({ host, request, socket, record, exit }) {
      if (request.tag.startsWith("mobile.recovery.")) {
        recoveryRequests.push({
          host,
          tag: request.tag,
          ...(request.payload?.serverEpoch ? { serverEpoch: request.payload.serverEpoch } : {}),
          ...(request.payload?.baselineSequence !== undefined
            ? { baselineSequence: request.payload.baselineSequence }
            : {}),
        });
      }
      if (request.tag === "mobile.recovery.subscribe")
        subscriptions.push({ host, socket, record, request });
      if (request.tag !== "mobile.recovery.getCommandOutcome") return false;
      outcomes.push({
        host,
        commandId: request.payload.commandId,
        accepted: accepted.has(request.payload.commandId),
      });
      if (host === "A" && accepted.has(request.payload.commandId)) {
        exit(request, {
          commandId: request.payload.commandId,
          status: "accepted",
          resultSequence: RESUME_SEQUENCES.A,
          serverEpoch: "host-A",
          canonicalRevision: RESUME_SEQUENCES.A,
        });
      }
      return true;
    },
  });
  await page.addInitScript(() => {
    const fixture = { visible: true, online: true, sockets: [] };
    globalThis.__mobileHostResumeFixture = fixture;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (fixture.visible ? "visible" : "hidden"),
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !fixture.visible });
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => fixture.online });
    const NativeWebSocket = WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        fixture.sockets.push(this);
      }
    };
  });
  return { state, unavailable, accepted, recoveryRequests, subscriptions, outcomes };
}

export async function signalHostResume(page, { visible, online }) {
  return page.evaluate(
    ({ visible, online }) => {
      const fixture = globalThis.__mobileHostResumeFixture;
      fixture.visible = visible;
      fixture.online = online;
      window.dispatchEvent(new Event(online ? "online" : "offline"));
      document.dispatchEvent(new Event("visibilitychange"));
      return { visibility: document.visibilityState, online: navigator.onLine };
    },
    { visible, online },
  );
}

export function closeResumeTransport(owned, host) {
  const active = owned.state.socketControls.findLast(
    (entry) => entry.host === host && !entry.record.closed,
  );
  assert.ok(active, `Expected active ${host} transport before simulated gateway loss`);
  active.socket.close({ code: 1013, reason: "fixture gateway unavailable" });
}

/** Already-queued native callback simulation, explicitly distinct from a live wire frame. */
export async function deliverRetiredRecoveryCallback(page, subscription) {
  assert.ok(subscription);
  return page.evaluate(
    ({ origin, requestId, attempt }) => {
      const socket = globalThis.__mobileHostResumeFixture.sockets.findLast(
        (candidate) => new URL(candidate.url).origin === origin,
      );
      if (!socket || socket.readyState !== WebSocket.CLOSED)
        throw new Error("Expected retired native A WebSocket before queued callback delivery");
      const delivered = socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            _tag: "Chunk",
            requestId,
            values: [
              {
                version: 1,
                route: "direct-unmanaged",
                serverEpoch: "host-A",
                recoveryAttemptId: attempt,
                type: "resync-required",
                reason: "gap",
              },
            ],
          }),
        }),
      );
      return { delivered, retiredSocket: socket.readyState === WebSocket.CLOSED };
    },
    {
      origin: HOSTS.A.replace("https:", "wss:"),
      requestId: subscription.request.id,
      attempt: subscription.request.payload.recoveryAttemptId,
    },
  );
}
