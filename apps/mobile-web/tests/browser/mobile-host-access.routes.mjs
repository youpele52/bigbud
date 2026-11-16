import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { snapshot, thread } from "./recovery.fixture.mjs";

export const HOSTS = { A: "https://host-a.invalid", B: "https://host-b.invalid" };
export const HOSTED = "https://mobile.bigbud.app";

/** Every non-asset/backend request is intercepted; no real host/account/provider is accessed. */
export async function installHostAccessRoutes(
  page,
  {
    localOrigin,
    appOrigin,
    config,
    descriptors,
    sessions,
    hostOrigins = HOSTS,
    handshakeBarrier,
    recoverySequences,
    onRpcRequest,
    allowSocket,
  },
) {
  const hostOf = (origin) => Object.keys(hostOrigins).find((host) => hostOrigins[host] === origin);
  const state = {
    http: [],
    rpc: [],
    sockets: [],
    rejected: [],
    errors: [],
    hmr: [],
    navigations: [],
    descriptors: structuredClone(descriptors),
    legacy: new Set(),
    held: [],
    socketControls: [],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error")
      state.errors.push(message.text().replace(/([?&]token=)[^\s"']+/g, "$1[redacted]"));
  });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true }),
  );
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const host = hostOf(url.origin);
    if (host && url.pathname.startsWith("/api/")) {
      const headers = {
        "access-control-allow-origin": appOrigin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "cache-control": "no-store",
        "content-type": "application/json",
      };
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      const kind =
        url.pathname === "/api/mobile/handshake"
          ? "handshake"
          : url.pathname.endsWith("/exchange")
            ? "exchange"
            : "status";
      state.http.push({ host, kind, method: request.method() });
      if (appOrigin !== HOSTED && url.origin !== appOrigin) {
        state.rejected.push(`foreign-api:${host}:${kind}`);
        return route.fulfill({ status: 403, headers, body: "{}" });
      }
      assert.equal(
        request.headers()["cookie"],
        undefined,
        "pairing/identity fetch must omit cookies",
      );
      assert.equal(request.headers()["authorization"], undefined);
      if (kind === "handshake") {
        await handshakeBarrier?.(host);
        return route.fulfill({
          status: state.legacy.has(host) ? 404 : 200,
          headers,
          body: JSON.stringify(state.descriptors[host]),
        });
      }
      assert.match(url.pathname, /^\/api\/mobile\/pairing\/fixture-pair-[AB](\/exchange)?$/);
      if (kind === "exchange") {
        assert.equal(request.method(), "POST");
        assert.equal(request.postDataJSON().secret, `fixture-secret-${host}`);
        const { backendBaseUrl: _origin, ...value } = sessions[host];
        return route.fulfill({ status: 200, headers, body: JSON.stringify(value) });
      }
      return route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({
          pairingId: `fixture-pair-${host}`,
          scope: sessions[host].scope,
          expiresAt: sessions[host].expiresAt,
          enabled: true,
          available: true,
        }),
      });
    }
    if (request.isNavigationRequest()) {
      state.navigations.push(`${url.origin}${url.pathname}`);
      if (url.origin !== appOrigin) {
        assert.equal(
          url.href,
          `${url.origin}/mobile/`,
          "directory navigation must have no query or fragment",
        );
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Destination host fixture</title><h1>Destination host fixture</h1>",
        });
      }
      const response = await fetch(`${localOrigin}/__mobile-host-access`);
      return route.fulfill({
        status: response.status,
        contentType: "text/html",
        body: await response.text(),
      });
    }
    if (url.pathname === "/favicon.ico") return route.fulfill({ status: 204 });
    if (url.pathname === "/@vite/client") {
      state.hmr.push(url.pathname);
      return route.abort();
    }
    if (
      url.origin === appOrigin &&
      /^(\/(src|tests|node_modules|@fs|@id|@vite)\/|\/fonts\/)/.test(url.pathname)
    ) {
      const response = await fetch(`${localOrigin}${url.pathname}${url.search}`);
      return route.fulfill({
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/javascript",
        body: Buffer.from(await response.arrayBuffer()),
      });
    }
    state.rejected.push(`${url.origin}${url.pathname}`);
    return route.abort();
  });
  await page.routeWebSocket("**/*", (socket) => {
    const url = new URL(socket.url());
    const host = hostOf(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`);
    if (
      !host ||
      url.pathname !== "/mobile-ws" ||
      (appOrigin !== HOSTED && hostOrigins[host] !== appOrigin)
    ) {
      state.rejected.push(`socket:${url.hostname}${url.pathname}`);
      return socket.close();
    }
    assert.equal(
      url.searchParams.get("token"),
      sessions[host].sessionToken,
      "credential must belong to destination host",
    );
    const record = { host, closed: false };
    state.sockets.push(record);
    state.socketControls.push({ host, socket, record });
    socket.onClose(() => {
      record.closed = true;
    });
    if (allowSocket?.(host) === false) {
      socket.close({ code: 1013, reason: "fixture transport unavailable" });
      return;
    }
    const exit = (request, value) =>
      socket.send(
        JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } }),
      );
    const hostThread = {
      ...thread,
      title: `Host ${host} thread`,
      messages: thread.messages.map((message) =>
        Object.assign({}, message, {
          text: `Host ${host} private fixture content`,
        }),
      ),
    };
    const sequence = recoverySequences?.[host] ?? 0;
    const hostSnapshot = {
      ...snapshot,
      snapshotSequence: sequence,
      projects: snapshot.projects.map((project) =>
        Object.assign({}, project, { title: `Host ${host} project` }),
      ),
      threads: [{ ...hostThread, messages: [] }],
    };
    socket.onMessage((raw) => {
      const request = JSON.parse(String(raw));
      if (request._tag !== "Request") return;
      state.rpc.push({
        host,
        tag: request.tag,
        ...(request.payload?.commandId ? { commandId: request.payload.commandId } : {}),
      });
      if (onRpcRequest?.({ host, request, socket, record, exit, state }) === true) return;
      if (request.tag === "subscribeServerConfig")
        socket.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: request.id,
            values: [{ version: 1, type: "snapshot", config }],
          }),
        );
      else if (request.tag === "mobile.recovery.getBaseline")
        exit(request, {
          version: 1,
          recoveryAttemptId: request.payload.recoveryAttemptId,
          serverEpoch: `host-${host}`,
          snapshotSequence: sequence,
          snapshot: hostSnapshot,
          selectedThread: request.payload.selectedThreadId
            ? { status: "present", thread: hostThread }
            : null,
        });
      else if (request.tag === "mobile.recovery.subscribe")
        socket.send(
          JSON.stringify({
            _tag: "Chunk",
            requestId: request.id,
            values: [
              {
                version: 1,
                route: "direct-unmanaged",
                serverEpoch: `host-${host}`,
                recoveryAttemptId: request.payload.recoveryAttemptId,
                type: "caught-up",
                throughSequence: sequence,
              },
            ],
          }),
        );
      else if (request.tag === "orchestration.getSnapshot") exit(request, hostSnapshot);
      else if (request.tag === "orchestration.getMobileThread") exit(request, hostThread);
      else if (request.tag === "orchestration.dispatchCommand")
        state.held.push({ host, socket, record, request, exit });
      // Original command outcomes remain uncertain, never replayed by this fixture.
    });
  });
  return state;
}
