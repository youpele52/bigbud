import { describe, expect, it } from "vitest";

import {
  authorizeRemoteClientRequest,
  REMOTE_CLIENT_HANDSHAKE_PATH,
} from "./clientAuthorization.ts";

const token = "fixture-private-owner";
const header = { authorization: `Bearer ${token}`, "x-bigbud-client-rpc-revision": "1" };
const request = (url: string, headers: Record<string, string> = header, method = "GET") =>
  authorizeRemoteClientRequest({ method, url, headers, expectedToken: token });

describe("remote client authorization", () => {
  it.each(["/", "/attachments/file", "/api/workspace/file", "/api/project/favicon", "/ws"])(
    "protects %s beyond the WebSocket route",
    (path) => {
      expect(request(path, {})).toBe("unauthorized");
      expect(request(path)).toBe("authorized");
    },
  );

  it("fails closed even when startup supplied no token", () => {
    expect(
      authorizeRemoteClientRequest({
        method: "GET",
        url: "/",
        headers: header,
        expectedToken: undefined,
      }),
    ).toBe("unauthorized");
  });

  it("permits the authenticated handshake before client revision negotiation", () => {
    expect(request(REMOTE_CLIENT_HANDSHAKE_PATH, { authorization: `Bearer ${token}` })).toBe(
      "authorized",
    );
    expect(request(REMOTE_CLIENT_HANDSHAKE_PATH, {})).toBe("unauthorized");
    expect(
      request(REMOTE_CLIENT_HANDSHAKE_PATH, { authorization: `Bearer ${token}` }, "POST"),
    ).toBe("incompatible");
  });

  it("requires compatible revision before exposing any other authenticated route", () => {
    expect(request("/attachments/file", { authorization: `Bearer ${token}` })).toBe("incompatible");
    expect(request("/", { ...header, "x-bigbud-client-rpc-revision": "2" })).toBe("incompatible");
    expect(request("/", { ...header, "x-bigbud-client-rpc-revision": "01" })).toBe("incompatible");
  });

  it("accepts a query credential only for an actual WebSocket upgrade", () => {
    const url = `/ws?token=${token}&clientRpcRevision=1`;
    expect(request(url, { upgrade: "websocket" })).toBe("authorized");
    expect(request(url, {})).toBe("unauthorized");
    expect(request(`/attachments/file?token=${token}`, {})).toBe("unauthorized");
    expect(request(url, { upgrade: "websocket" }, "POST")).toBe("unauthorized");
  });

  it("rejects ambiguous credentials and revision values rather than choosing one", () => {
    expect(
      request(`/ws?token=${token}&token=${token}&clientRpcRevision=1`, { upgrade: "websocket" }),
    ).toBe("unauthorized");
    expect(
      request(`/ws?token=wrong&clientRpcRevision=1`, { ...header, upgrade: "websocket" }),
    ).toBe("unauthorized");
    expect(
      request(`/ws?token=${token}&clientRpcRevision=1&clientRpcRevision=1`, {
        upgrade: "websocket",
      }),
    ).toBe("incompatible");
    expect(
      request(`/ws?token=${token}&clientRpcRevision=2`, { ...header, upgrade: "websocket" }),
    ).toBe("incompatible");
  });

  it("rejects malformed, wrong and oversized authorization without leaking credentials", () => {
    for (const authorization of [
      "Basic value",
      "Bearer wrong",
      `Bearer ${token} extra`,
      `Bearer ${"x".repeat(5000)}`,
    ]) {
      expect(request("/", { ...header, authorization })).toBe("unauthorized");
    }
    expect(request("/", { ...header, authorization: `bearer ${token}` })).toBe("authorized");
  });
});
