import { describe, expect, it } from "vitest";

import { resolveMobileWebsocketUrl } from "./mobileSession";

describe("mobileSession", () => {
  it("builds the mobile websocket url from the backend origin and session token", () => {
    expect(
      resolveMobileWebsocketUrl({
        sessionId: "session-1",
        sessionToken: "token-1",
        websocketUrl: "ws://127.0.0.1:3774/mobile-ws?token=stale",
        backendBaseUrl: "http://127.0.0.1:3774",
        scope: "thread-control",
        expiresAt: "2026-07-01T12:00:00.000Z",
      }),
    ).toBe("ws://127.0.0.1:3774/mobile-ws?token=token-1");
  });
});
