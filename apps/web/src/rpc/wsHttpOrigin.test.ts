import { describe, expect, it } from "vitest";

import { resolveWsHttpOriginFrom } from "./wsHttpOrigin";

describe("resolveWsHttpOriginFrom", () => {
  it("uses the desktop backend origin rather than the Vite renderer origin", () => {
    expect(
      resolveWsHttpOriginFrom({
        bridgeWsUrl: "ws://127.0.0.1:3774/?token=desktop-token",
        envWsUrl: "ws://127.0.0.1:3773",
        fallbackOrigin: "http://localhost:5734",
      }),
    ).toBe("http://127.0.0.1:3774");
  });

  it("uses VITE_WS_URL when no desktop bridge endpoint is available", () => {
    expect(
      resolveWsHttpOriginFrom({
        bridgeWsUrl: null,
        envWsUrl: "wss://server.example.test/ws?token=dev-token",
        fallbackOrigin: "http://localhost:5734",
      }),
    ).toBe("https://server.example.test");
  });
});
