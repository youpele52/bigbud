import { describe, expect, it } from "vitest";

import {
  assertRemoteServerProfile,
  assertRemoteStartupOptions,
  remoteClientSocketPath,
} from "./config.remote.ts";

const valid = {
  mode: "remote",
  authToken: "fixture-owner-secret",
  devUrl: undefined,
  host: undefined,
  bootstrapRequested: false,
};

describe("remote startup policy", () => {
  it("refuses desktop descriptors and implicit browser/workspace behavior from direct embeddings", () => {
    const config = { ...valid, noBrowser: true, autoBootstrapProjectFromCwd: false };
    expect(() => assertRemoteServerProfile(config, "linux")).not.toThrow();
    for (const extra of [
      { desktopLifecycleHintFd: 5 },
      { desktopStartReason: "unexpected-exit-restart" },
      { desktopOwnershipHandoff: false },
      { noBrowser: false },
      { autoBootstrapProjectFromCwd: true },
    ])
      expect(() => assertRemoteServerProfile({ ...config, ...extra }, "linux")).toThrow();
  });

  it("requires a usable explicit authentication token before any startup side effects", () => {
    for (const authToken of [
      undefined,
      "",
      " ",
      "owner secret",
      "owner\nsecret",
      "x".repeat(4097),
      "é".repeat(2049),
    ]) {
      expect(() => assertRemoteStartupOptions({ ...valid, authToken }, "linux")).toThrow(
        "authentication token",
      );
    }
    expect(() => assertRemoteStartupOptions(valid, "linux")).not.toThrow();
  });

  it.each(["darwin", "win32"] as const)("refuses unsupported %s remote hosts", (platform) => {
    expect(() => assertRemoteStartupOptions(valid, platform)).toThrow("Linux");
  });

  it("refuses desktop pipe/bootstrap coupling and development proxies", () => {
    expect(() =>
      assertRemoteStartupOptions({ ...valid, bootstrapRequested: true }, "linux"),
    ).toThrow("desktop bootstrap");
    expect(() =>
      assertRemoteStartupOptions({ ...valid, devUrl: new URL("http://127.0.0.1:5740") }, "linux"),
    ).toThrow("development server");
  });

  it("keeps callback binding private and permits an explicit loopback", () => {
    for (const host of ["0.0.0.0", "::", "localhost", "100.64.0.1"]) {
      expect(() => assertRemoteStartupOptions({ ...valid, host }, "linux")).toThrow(
        "private Unix socket",
      );
    }
    expect(() =>
      assertRemoteStartupOptions({ ...valid, host: "127.0.0.1" }, "linux"),
    ).not.toThrow();
  });

  it("does not alter the existing web and desktop startup rules", () => {
    for (const mode of ["web", "desktop"]) {
      expect(() =>
        assertRemoteStartupOptions(
          { ...valid, mode, authToken: undefined, bootstrapRequested: true },
          "darwin",
        ),
      ).not.toThrow();
    }
  });

  it("uses a stable state-owned Unix path and enforces its encoded byte limit", () => {
    expect(remoteClientSocketPath("/private/remote/userdata")).toBe(
      "/private/remote/userdata/remote-backend.sock",
    );
    expect(() => remoteClientSocketPath(`/remote/${"x".repeat(100)}`)).toThrow("too long");
    expect(() => remoteClientSocketPath(`/remote/${"é".repeat(50)}`)).toThrow("too long");
  });
});
