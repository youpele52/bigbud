import { describe, expect, it } from "vitest";

import {
  assessServeMapping,
  describeServeMappingError,
  parseLoopbackRootProxyPort,
} from "./tailscaleRemoteAccess.serveConfig";

const web = (handlers: Record<string, unknown>) => ({
  Web: { "host.tail1.ts.net:443": { Handlers: handlers } },
});

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
    expect(assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3774" } }), 3774)).toEqual({
      kind: "current",
      otherHandlerCount: 0,
    });
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3773" } }), 3774, 3773),
    ).toEqual({ kind: "stale", stalePort: 3773 });
    // A loopback service bigbud did not record (for example Grafana) is never "stale".
    expect(
      assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3000" } }), 3774, 3773),
    ).toEqual({ kind: "foreign", loopbackPort: 3000 });
    expect(assessServeMapping(web({ "/": { Proxy: "http://127.0.0.1:3773" } }), 3774)).toEqual({
      kind: "foreign",
      loopbackPort: 3773,
    });
    expect(assessServeMapping(web({ "/": { Proxy: "http://10.0.0.2:80" } }), 3774)).toEqual({
      kind: "foreign",
      loopbackPort: null,
    });
    expect(assessServeMapping(web({ "/x": { Proxy: "http://127.0.0.1:1" } }), 3774)).toEqual({
      kind: "none",
    });
    expect(assessServeMapping({}, 3774)).toEqual({ kind: "none" });
    expect(assessServeMapping(null, 3774)).toEqual({ kind: "none" });
  });

  it("names both ports for a stale mapping without suggesting a public fallback", () => {
    const message = describeServeMappingError({ kind: "stale", stalePort: 3773 }, 3774);
    expect(message).toContain("127.0.0.1:3773");
    expect(message).toContain("3774");
    expect(message?.toLowerCase()).not.toContain("funnel");
  });
});
