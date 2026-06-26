import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveAdvertisedIpv4Host,
  resolveDesktopMobileRemoteNetwork,
} from "./mobileRemoteNetwork";

describe("mobileRemoteNetwork", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "bigbud-mobile-remote-"));
    tempDirs.push(dir);
    return dir;
  }

  it("prefers RFC1918 LAN addresses for mobile remote advertising", () => {
    expect(
      resolveAdvertisedIpv4Host(() => ({
        en0: [
          {
            address: "100.72.1.4",
            family: "IPv4",
            internal: false,
            netmask: "255.255.255.255",
            cidr: "100.72.1.4/32",
            mac: "00:00:00:00:00:00",
          },
          {
            address: "192.168.1.24",
            family: "IPv4",
            internal: false,
            netmask: "255.255.255.0",
            cidr: "192.168.1.24/24",
            mac: "00:00:00:00:00:01",
          },
        ],
      })),
    ).toBe("192.168.1.24");
  });

  it("keeps desktop loopback-only without an explicit host override", () => {
    const settingsPath = path.join(createTempDir(), "settings.json");

    expect(
      resolveDesktopMobileRemoteNetwork({
        serverSettingsPath: settingsPath,
      }),
    ).toEqual({
      bindHost: "127.0.0.1",
      clientHost: "127.0.0.1",
      advertisedHost: "127.0.0.1",
    });
  });

  it("uses explicit host overrides without consulting persisted settings", () => {
    const settingsPath = path.join(createTempDir(), "settings.json");

    expect(
      resolveDesktopMobileRemoteNetwork({
        serverSettingsPath: settingsPath,
        hostOverride: "100.88.10.4",
      }),
    ).toEqual({
      bindHost: "100.88.10.4",
      clientHost: "100.88.10.4",
      advertisedHost: "100.88.10.4",
    });
  });
});
