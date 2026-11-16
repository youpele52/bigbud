import { describe, expect, it } from "vitest";
import { authorizeWebsocketRpcConnection as authorize } from "./wsConnectionAuthorization.ts";

const remote = {
  mode: "remote",
  authToken: "private-backend-token",
  url: "/ws?clientRpcRevision=1",
  headers: { upgrade: "websocket", authorization: "Bearer private-backend-token" },
};

describe("WebSocket RPC authorization", () => {
  it("accepts the private relay's header-only credential", () => {
    expect(authorize(remote)).toBe("authorized");
  });
  it("accepts compatible direct-client query credentials", () => {
    expect(
      authorize({
        ...remote,
        url: "/ws?clientRpcRevision=1&token=private-backend-token",
        headers: { upgrade: "websocket" },
      }),
    ).toBe("authorized");
  });
  it("refuses missing, wrong, conflicting and repeated remote credentials", () => {
    for (const headers of [
      { upgrade: "websocket" },
      { ...remote.headers, authorization: "Bearer wrong" },
    ])
      expect(authorize({ ...remote, headers })).toBe("unauthorized");
    expect(authorize({ ...remote, url: remote.url + "&token=wrong" })).toBe("unauthorized");
    expect(
      authorize({
        ...remote,
        url: remote.url + "&token=private-backend-token&token=private-backend-token",
      }),
    ).toBe("unauthorized");
  });
  it("requires compatible unambiguous remote RPC revisions", () => {
    expect(authorize({ ...remote, url: "/ws" })).toBe("incompatible");
    expect(
      authorize({ ...remote, headers: { ...remote.headers, "x-bigbud-client-rpc-revision": "2" } }),
    ).toBe("incompatible");
    expect(authorize({ ...remote, url: remote.url + "&clientRpcRevision=1" })).toBe("incompatible");
  });
  it("preserves local query authentication without accepting remote header credentials", () => {
    expect(authorize({ ...remote, mode: "desktop" })).toBe("unauthorized");
    expect(authorize({ ...remote, mode: "desktop", url: "/ws?token=private-backend-token" })).toBe(
      "authorized",
    );
    expect(authorize({ ...remote, mode: "web", authToken: undefined })).toBe("authorized");
    expect(authorize({ ...remote, mode: "desktop", url: "http://[" })).toBe("invalid-url");
  });
});
