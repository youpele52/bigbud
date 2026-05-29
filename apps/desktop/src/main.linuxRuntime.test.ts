import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveLinuxDesktopRuntimeConfig,
  resolveLinuxGpuFallbackMarkerPath,
  shouldArmLinuxGpuFallback,
} from "./main.linuxRuntime";

describe("resolveLinuxDesktopRuntimeConfig", () => {
  it("defaults Linux backend memory to 1024 MB", () => {
    const config = resolveLinuxDesktopRuntimeConfig({
      env: {},
      platform: "linux",
    });

    expect(config.backendMaxOldSpaceMb).toBe(1024);
    expect(config.disableHardwareAcceleration).toBe(false);
    expect(config.spellcheckEnabled).toBe(true);
  });

  it("enables conservative Linux mode from env", () => {
    const config = resolveLinuxDesktopRuntimeConfig({
      env: {
        BIGBUD_LINUX_CONSERVATIVE_MODE: "1",
      },
      platform: "linux",
    });

    expect(config.conservativeMode).toBe(true);
    expect(config.backendMaxOldSpaceMb).toBe(768);
    expect(config.disableHardwareAcceleration).toBe(true);
    expect(config.spellcheckEnabled).toBe(false);
  });

  it("honors explicit backend memory overrides", () => {
    const config = resolveLinuxDesktopRuntimeConfig({
      env: {
        BIGBUD_DESKTOP_BACKEND_MAX_OLD_SPACE_MB: "1536",
      },
      platform: "linux",
    });

    expect(config.backendMaxOldSpaceMb).toBe(1536);
  });

  it("arms hardware acceleration fallback from a persisted marker", () => {
    const config = resolveLinuxDesktopRuntimeConfig({
      env: {},
      gpuFallbackMarkerArmed: true,
      platform: "linux",
    });

    expect(config.gpuFallbackMarkerArmed).toBe(true);
    expect(config.disableHardwareAcceleration).toBe(true);
  });

  it("allows an explicit env override to keep hardware acceleration enabled", () => {
    const config = resolveLinuxDesktopRuntimeConfig({
      env: {
        BIGBUD_LINUX_DISABLE_HARDWARE_ACCELERATION: "0",
      },
      gpuFallbackMarkerArmed: true,
      platform: "linux",
    });

    expect(config.disableHardwareAcceleration).toBe(false);
  });

  it("parses ozone platform overrides on Linux only", () => {
    expect(
      resolveLinuxDesktopRuntimeConfig({
        env: {
          BIGBUD_LINUX_OZONE_PLATFORM: "x11",
        },
        platform: "linux",
      }).ozonePlatform,
    ).toBe("x11");

    expect(
      resolveLinuxDesktopRuntimeConfig({
        env: {
          BIGBUD_LINUX_OZONE_PLATFORM: "wayland",
        },
        platform: "darwin",
      }).ozonePlatform,
    ).toBeNull();
  });
});

describe("resolveLinuxGpuFallbackMarkerPath", () => {
  it("stores the marker inside the desktop state directory", () => {
    expect(resolveLinuxGpuFallbackMarkerPath("/tmp/bigbud/userdata")).toBe(
      Path.join("/tmp/bigbud/userdata", "linux-gpu-fallback.json"),
    );
  });
});

describe("shouldArmLinuxGpuFallback", () => {
  it("treats GPU crashes and launch failures as fallback-worthy", () => {
    expect(shouldArmLinuxGpuFallback("crashed")).toBe(true);
    expect(shouldArmLinuxGpuFallback("launch-failed")).toBe(true);
    expect(shouldArmLinuxGpuFallback("normal-exit")).toBe(false);
  });
});
