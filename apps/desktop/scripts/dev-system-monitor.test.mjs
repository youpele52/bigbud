import { describe, expect, it, vi } from "vitest";

import { prepareDevSystemMonitorEnv } from "./dev-system-monitor.mjs";

describe("dev system monitor binary", () => {
  it("builds the supervisor and passes its absolute path to Electron", () => {
    const build = vi.fn(() => ({ status: 0 }));
    const binaryExists = vi.fn(() => true);
    const env = prepareDevSystemMonitorEnv({}, "/repo", {
      build,
      binaryExists,
      platform: "linux",
    });
    expect(build).toHaveBeenCalledWith(
      "cargo",
      ["build", "--locked", "--package", "bigbud-desktop-supervisor"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(env.BIGBUD_SYSTEM_MONITOR_BINARY).toBe("/repo/target/debug/bigbud-desktop-supervisor");
    expect(binaryExists).toHaveBeenCalledWith(env.BIGBUD_SYSTEM_MONITOR_BINARY);
  });

  it("preserves an explicit override and disabled monitoring", () => {
    const build = vi.fn();
    expect(
      prepareDevSystemMonitorEnv({ BIGBUD_SYSTEM_MONITOR_BINARY: "/custom/monitor" }, "/repo", {
        build,
      }).BIGBUD_SYSTEM_MONITOR_BINARY,
    ).toBe("/custom/monitor");
    expect(
      prepareDevSystemMonitorEnv({ BIGBUD_SYSTEM_MONITOR_ENABLED: "0" }, "/repo", { build })
        .BIGBUD_SYSTEM_MONITOR_BINARY,
    ).toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });
});
