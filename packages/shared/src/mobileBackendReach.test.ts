import { describe, expect, it } from "vitest";

import {
  classifyMobileBackendReach,
  isOffNetworkMobileReach,
  toRedactedMobileOrigin,
} from "./mobileBackendReach";

describe("mobileBackendReach", () => {
  it.each([
    ["https://desktop.tail123.ts.net", "tailnet-https"],
    ["https://DESKTOP.tail123.ts.net:443", "tailnet-https"],
    ["https://bigbud.example.com", "other-https"],
    ["https://100.101.102.103", "other-https"],
    ["https://192.168.1.5", "lan-https"],
    ["https://box.local:8443", "lan-https"],
    ["http://100.101.102.103:3773", "tailnet-http"],
    ["http://desktop.tail123.ts.net", "tailnet-http"],
    ["http://192.168.1.20:3773", "lan-http"],
    ["http://10.0.0.5:3773", "lan-http"],
    ["http://172.20.1.1:3773", "lan-http"],
    ["http://desktop.local:3773", "lan-http"],
    ["http://127.0.0.1:3773", "loopback"],
    ["http://localhost:3773", "loopback"],
    ["http://[::1]:3773", "loopback"],
    ["http://203.0.113.9:3773", "other-http"],
    ["http://100.200.1.1:3773", "other-http"],
    ["ftp://desktop.tail123.ts.net", "invalid"],
    ["not a url", "invalid"],
  ])("classifies %s as %s", (origin, expected) => {
    expect(classifyMobileBackendReach(origin)).toBe(expected);
  });

  it("only treats HTTPS origins as off-network capable", () => {
    expect(isOffNetworkMobileReach("tailnet-https")).toBe(true);
    expect(isOffNetworkMobileReach("other-https")).toBe(true);
    expect(isOffNetworkMobileReach("lan-http")).toBe(false);
    expect(isOffNetworkMobileReach("lan-https")).toBe(false);
    expect(isOffNetworkMobileReach("tailnet-http")).toBe(false);
    expect(isOffNetworkMobileReach("loopback")).toBe(false);
  });

  it("redacts paths, queries, fragments and userinfo from origins", () => {
    expect(
      toRedactedMobileOrigin(
        "https://user:pw@desktop.tail1.ts.net/mobile-ws?token=secret#secret=x",
      ),
    ).toBe("https://desktop.tail1.ts.net");
    expect(toRedactedMobileOrigin("garbage")).toBeNull();
  });
});
