import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readPersistedMobileRemoteEnabled,
  resolveAdvertisedIpv4Host,
  resolveDesktopMobileRemoteNetwork,
} from "./mobileRemoteNetwork";

function writeSettings(dir: string, content: object): string {
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(content), "utf8");
  return settingsPath;
}

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

  it("reads persisted mobile remote enablement from settings", () => {
    const settingsPath = writeSettings(createTempDir(), {
      mobileRemoteControl: { enabled: true },
    });

    expect(readPersistedMobileRemoteEnabled(settingsPath)).toBe(true);
  });

  it("keeps desktop loopback-only when mobile remote is disabled", () => {
    const settingsPath = writeSettings(createTempDir(), {
      mobileRemoteControl: { enabled: false },
    });

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

  it("widens the backend bind host when mobile remote is enabled", () => {
    const settingsPath = writeSettings(createTempDir(), {
      mobileRemoteControl: { enabled: true },
    });

    expect(
      resolveDesktopMobileRemoteNetwork({
        serverSettingsPath: settingsPath,
        networkInterfaces: () => ({
          en0: [
            {
              address: "192.168.1.24",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "192.168.1.24/24",
              mac: "00:00:00:00:00:01",
            },
          ],
        }),
      }),
    ).toEqual({
      bindHost: "0.0.0.0",
      clientHost: "127.0.0.1",
      advertisedHost: "192.168.1.24",
    });
  });

  it("uses explicit host overrides without consulting persisted settings", () => {
    const settingsPath = writeSettings(createTempDir(), {
      mobileRemoteControl: { enabled: true },
    });

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
