import { describe, expect, it } from "vitest";

import {
  assessServeMapping,
  describeOtherServeRoutes,
  describeServeMappingError,
  isOnlyOwnHandlerOnListener,
  parseLoopbackRootProxyPort,
} from "./tailscaleRemoteAccess.serveConfig";

const HOST = "host.tail1.ts.net";
const web = (handlers: Record<string, unknown>, port = 443) => ({
  Web: { [`${HOST}:${port}`]: { Handlers: handlers } },
});
const stable = (backendPort: number) => ({ backendPort, httpsPort: 443 });
const beta = (backendPort: number) => ({ backendPort, httpsPort: 8443 });

describe("tailscaleRemoteAccess.serveConfig", () => {
  it.each([
    ["http://127.0.0.1:3773", 3773],
    ["http://127.0.0.1:3773/", 3773],
    ["127.0.0.1:3773", 3773],
    ["https://127.0.0.1:8443", 8443],
    ["http://127.0.0.1:3773/api", null],
    ["http://localhost:3773", null],
    ["http://127.0.0.1", null],
    ["unix:/tmp/x.sock", null],
    ["", null],
  ])("parses loopback root proxy %s", (target, expected) => {
    expect(parseLoopbackRootProxyPort(target)).toBe(expected);
  });

  it("classifies current, owned-stale, foreign and absent mappings", () => {
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3774" } }), stable(3774)),
    ).toEqual({ kind: "current", otherHandlerCount: 0 });
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3773" } }), stable(3774), 3773),
    ).toEqual({ kind: "stale", stalePort: 3773 });
    // A loopback service bigbud did not record (for example Grafana) is never "stale".
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3000" } }), stable(3774), 3773),
    ).toEqual({ kind: "foreign", loopbackPort: 3000 });
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3773" } }), stable(3774)),
    ).toEqual({ kind: "foreign", loopbackPort: 3773 });
    expect(assessServeMapping(web({ "/": { Proxy: "http://10.0.0.2:80" } }), stable(3774))).toEqual(
      {
        kind: "foreign",
        loopbackPort: null,
      },
    );
    expect(
      assessServeMapping(web({ "/x": { Proxy: "http://127.0.0.1:1" } }), stable(3774)),
    ).toEqual({
      kind: "none",
    });
    expect(assessServeMapping({}, stable(3774))).toEqual({ kind: "none" });
    expect(assessServeMapping(null, stable(3774))).toEqual({ kind: "none" });
  });

  it("only reads the channel's own listener, so stable's 443 never blocks beta's 8443", () => {
    const both = {
      Web: {
        [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
        [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3774" } } },
      },
    };
    expect(assessServeMapping(both, stable(3773))).toMatchObject({ kind: "current" });
    expect(assessServeMapping(both, beta(3774))).toMatchObject({ kind: "current" });
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3773" } }), beta(3774)),
    ).toEqual({ kind: "none" });
    // A listener whose port merely ends with the same digits is a different listener.
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3774" } }, 18443), beta(3774)),
    ).toEqual({ kind: "none" });
  });

  it("allows turning off only a listener that holds nothing but bigbud's handler", () => {
    const config = {
      Web: {
        [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
        [`${HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3774" } } },
      },
    };
    // Other channels' listeners do not block turning off this one.
    expect(isOnlyOwnHandlerOnListener(config, 3774, 8443)).toBe(true);
    const shared = web(
      { "/": { Proxy: "http://127.0.0.1:3774" }, "/grafana": { Proxy: "http://127.0.0.1:3000" } },
      8443,
    );
    expect(isOnlyOwnHandlerOnListener(shared, 3774, 8443)).toBe(false);
    expect(describeOtherServeRoutes(shared, 3774, 8443)).toBe(
      "/grafana on port 8443 → http://127.0.0.1:3000",
    );
  });

  it("names both ports for a stale mapping without suggesting a public fallback", () => {
    const message = describeServeMappingError({ kind: "stale", stalePort: 3773 }, stable(3774));
    expect(message).toContain("127.0.0.1:3773");
    expect(message).toContain("3774");
    expect(message?.toLowerCase()).not.toContain("funnel");
  });

  it("names the channel's HTTPS port in a foreign mapping message", () => {
    expect(
      describeServeMappingError({ kind: "foreign", loopbackPort: 3000 }, beta(3774)),
    ).toContain("HTTPS port 8443 already forwards");
  });
});
