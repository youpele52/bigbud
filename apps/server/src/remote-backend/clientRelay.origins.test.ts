import { afterEach, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { openClientRelayOwner } from "./clientRelay.owner.ts";
import { clientRelayAllowedOrigins, DESKTOP_APP_RENDERER_ORIGIN } from "./clientRelay.origins.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

it("desktop mode adds exactly the packaged renderer origin; loopback and dev rules unchanged", () => {
  const devUrl = new URL("http://localhost:5733/some/path");
  expect(clientRelayAllowedOrigins({ port: 3773, devUrl, mode: "desktop" })).toEqual([
    "http://127.0.0.1:3773",
    "http://localhost:3773",
    "http://localhost:5733",
    "bigbud://app",
  ]);
  expect(clientRelayAllowedOrigins({ port: 3773, devUrl: undefined, mode: "web" })).toEqual([
    "http://127.0.0.1:3773",
    "http://localhost:3773",
  ]);
  expect(clientRelayAllowedOrigins({ port: 1, devUrl: undefined, mode: "remote" })).not.toContain(
    DESKTOP_APP_RENDERER_ORIGIN,
  );
});

it("relay owner admits bigbud://app and refuses lookalike scheme origins", async () => {
  let opens = 0;
  const owner = await openClientRelayOwner({
    allowedOrigins: clientRelayAllowedOrigins({ port: 3773, devUrl: undefined, mode: "desktop" }),
    openChannel: async () => {
      opens++;
      return new PassThrough();
    },
  });
  cleanup.push(owner.dispose);
  const preflight = (origin: string) =>
    fetch(owner.baseUrl + "/api/remote-backend/handshake", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-headers": "authorization" },
    });
  const allowed = await preflight("bigbud://app");
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("access-control-allow-origin")).toBe("bigbud://app");
  for (const origin of [
    "bigbud://app.evil",
    "bigbud://other",
    "evil://app",
    "BIGBUD://APP",
    "bigbud://app:1",
  ])
    expect((await preflight(origin)).status, origin).toBe(403);
  expect(opens).toBe(0);
});
