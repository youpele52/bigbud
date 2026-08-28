import { describe, expect, it } from "vitest";

import {
  desktopSupervisorRestartDelayMs,
  resolveDesktopSupervisorRuntimeConfig,
} from "./desktopSupervisorConfig.ts";

describe("desktop supervisor runtime selection", () => {
  it("keeps standalone server delivery direct by default", () => {
    expect(resolveDesktopSupervisorRuntimeConfig({})).toEqual({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
  });

  it("enables a valid packaged supervisor by default", () => {
    expect(
      resolveDesktopSupervisorRuntimeConfig(
        {
          BIGBUD_DESKTOP_PACKAGED: "1",
          BIGBUD_DESKTOP_SUPERVISOR_BINARY: "/fixture/supervisor",
        },
        () => true,
      ),
    ).toEqual({ mode: "supervisor", binaryPath: "/fixture/supervisor" });
  });

  it("uses an explicit fenced fallback when a packaged binary is missing", () => {
    expect(resolveDesktopSupervisorRuntimeConfig({ BIGBUD_DESKTOP_PACKAGED: "1" })).toEqual({
      mode: "fallback-fenced",
      reasonCode: "binary_missing",
    });
  });

  it("supports development opt-in and startup rollback disablement", () => {
    expect(
      resolveDesktopSupervisorRuntimeConfig(
        {
          BIGBUD_DESKTOP_SUPERVISOR_ENABLED: "1",
          BIGBUD_DESKTOP_SUPERVISOR_BINARY: "/fixture/supervisor",
        },
        () => true,
      ).mode,
    ).toBe("supervisor");
    expect(
      resolveDesktopSupervisorRuntimeConfig({
        BIGBUD_DESKTOP_PACKAGED: "1",
        BIGBUD_DESKTOP_SUPERVISOR_ENABLED: "0",
      }),
    ).toEqual({ mode: "direct-unmanaged", reasonCode: "disabled" });
  });

  it("uses capped deterministic restart backoff with jitter", () => {
    expect(desktopSupervisorRestartDelayMs(1)).toBeGreaterThanOrEqual(100);
    expect(desktopSupervisorRestartDelayMs(20)).toBeLessThanOrEqual(1_052);
  });
});
