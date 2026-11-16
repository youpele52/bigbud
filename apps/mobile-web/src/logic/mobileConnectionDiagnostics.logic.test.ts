import { describe, expect, it } from "vitest";

import { initialMobileConnectionState } from "./mobileConnection.logic";
import {
  buildMobileConnectionDiagnostics,
  diagnosticsInputFromConnection,
} from "./mobileConnectionDiagnostics.logic";

const HOSTED = "https://mobile.bigbud.app";

describe("mobileConnectionDiagnostics", () => {
  it("flags a saved LAN origin as same-network only and blocked from an HTTPS page", () => {
    const result = buildMobileConnectionDiagnostics({
      pageOrigin: HOSTED,
      backendBaseUrl: "http://192.168.1.20:3773",
      http: "unreachable",
    });
    expect(result.reach).toBe("lan-http");
    expect(result.findings.join(" ")).toContain("same network as the host");
    expect(result.findings.join(" ")).toContain("browser blocks the connection");
    expect(result.stages[0]?.detail).toContain("not usable off this network");
  });

  it("lists Tailscale prerequisites and cross-site restriction only as possibilities", () => {
    const result = buildMobileConnectionDiagnostics({
      pageOrigin: HOSTED,
      backendBaseUrl: "https://desktop.tail1.ts.net",
      http: "unreachable",
    });
    expect(result.reach).toBe("tailnet-https");
    expect(result.findings.join(" ")).toContain(
      "Tailscale is signed in and connected on this phone",
    );
    expect(result.findings.join(" ")).toContain("possible cause, not a confirmed one");
    const http = result.stages.find((stage) => stage.stage === "http");
    expect(http?.status).toBe("failed");
    expect(http?.detail).toContain("does not say which");
  });

  it("treats private-network HTTPS as same-network only", () => {
    const result = buildMobileConnectionDiagnostics({
      pageOrigin: HOSTED,
      backendBaseUrl: "https://192.168.1.5:8443",
    });
    expect(result.reach).toBe("lan-https");
    expect(result.findings.join(" ")).toContain("same network as the host");
    expect(result.stages[0]?.detail).toContain("not usable off this network");
  });

  it("omits the cross-site note when the page is served by the desktop itself", () => {
    const result = buildMobileConnectionDiagnostics({
      pageOrigin: "https://desktop.tail1.ts.net",
      backendBaseUrl: "https://desktop.tail1.ts.net",
    });
    expect(result.findings.join(" ")).not.toContain("different site");
  });

  it("never echoes tokens, paths or fragments from the stored address", () => {
    const result = buildMobileConnectionDiagnostics({
      pageOrigin: `${HOSTED}/mobile/pair/abc#secret=pairing-secret`,
      backendBaseUrl: "https://desktop.tail1.ts.net/mobile-ws?token=session-secret",
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("session-secret");
    expect(text).not.toContain("pairing-secret");
    expect(result.origin).toBe("https://desktop.tail1.ts.net");
  });

  it("marks loopback and invalid addresses as failed at the address stage", () => {
    for (const backendBaseUrl of ["http://127.0.0.1:3773", "nonsense"]) {
      const result = buildMobileConnectionDiagnostics({ pageOrigin: HOSTED, backendBaseUrl });
      expect(result.stages[0]?.status).toBe("failed");
    }
  });

  it("maps connection lifecycle evidence onto stages", () => {
    const base = initialMobileConnectionState();
    expect(
      diagnosticsInputFromConnection({
        connection: { ...base, transport: "open" },
        freshness: "current",
      }),
    ).toEqual({
      websocket: "open",
      authorization: "accepted",
      catchUp: "current",
      browserOffline: false,
    });
    expect(
      diagnosticsInputFromConnection({
        connection: { ...base, transport: "exhausted", authorization: "explicitly-rejected" },
        freshness: "unavailable",
      }),
    ).toMatchObject({ websocket: "failed", authorization: "rejected", catchUp: "not-run" });
    expect(
      diagnosticsInputFromConnection({
        connection: { ...base, transport: "closed", expired: true, browserOffline: true },
        freshness: "unavailable",
      }),
    ).toMatchObject({ authorization: "expired", browserOffline: true });
    expect(
      diagnosticsInputFromConnection({
        connection: { ...base, transport: "open" },
        freshness: "unavailable",
      }).catchUp,
    ).toBe("unavailable");
  });
});

describe("classifyMobilePairingHttpFailure", () => {
  it("classifies by HTTP status instead of calling every failure a refusal", async () => {
    const { classifyMobilePairingHttpFailure, MobilePairingHttpError } =
      await import("./mobileConnectionDiagnostics.logic");
    const http = (status: number) =>
      classifyMobilePairingHttpFailure(
        new MobilePairingHttpError(status, "Pairing link is invalid or expired."),
      );
    expect(http(404)).toBe("rejected");
    expect(http(401)).toBe("rejected");
    expect(http(429)).toBe("rate-limited");
    expect(http(502)).toBe("host-unavailable");
    expect(http(504)).toBe("host-unavailable");
    expect(http(500)).toBe("server-error");
    expect(new MobilePairingHttpError(502, "x").message).toContain("not responding");
    expect(new MobilePairingHttpError(404, "Pairing link is invalid or expired.").message).toBe(
      "Pairing link is invalid or expired.",
    );
  });

  it("distinguishes timeout, opaque network failure and unexpected errors", async () => {
    const { classifyMobilePairingHttpFailure, MOBILE_PAIRING_TIMEOUT_MESSAGE } =
      await import("./mobileConnectionDiagnostics.logic");
    expect(
      classifyMobilePairingHttpFailure(new Error("Timed out reaching the desktop backend.")),
    ).toBe("timeout");
    expect(classifyMobilePairingHttpFailure(new Error(MOBILE_PAIRING_TIMEOUT_MESSAGE))).toBe(
      "timeout",
    );
    expect(classifyMobilePairingHttpFailure(new TypeError("Load failed"))).toBe("unreachable");
    expect(classifyMobilePairingHttpFailure(new SyntaxError("Unexpected token"))).toBe("unknown");
    expect(classifyMobilePairingHttpFailure("x")).toBe("unknown");
  });
});
