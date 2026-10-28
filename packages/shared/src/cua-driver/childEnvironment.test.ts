import { describe, expect, it } from "vitest";

import {
  CUA_DRIVER_STATE_HOME_KEY,
  cuaDriverStateEnvironment,
  makeCuaDriverChildEnvironment,
} from "./childEnvironment";
import { cuaDriverCursorThemeDirectory } from "./cursorTheme";

describe("makeCuaDriverChildEnvironment", () => {
  it("keeps required desktop variables and strips credentials", () => {
    expect(
      makeCuaDriverChildEnvironment({
        PATH: "/bin",
        DISPLAY: ":0",
        OPENAI_API_KEY: "secret",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "true",
      }),
    ).toEqual({
      PATH: "/bin",
      DISPLAY: ":0",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    });
  });

  it("keeps the real HOME and moves Driver-owned state into the private state home", () => {
    const stateHome = "/base/runtime/cua-driver/home";
    // Only the carrier key is forwarded; the Driver overrides are derived at spawn.
    expect(cuaDriverStateEnvironment(stateHome)).toEqual({
      [CUA_DRIVER_STATE_HOME_KEY]: stateHome,
    });
    expect(
      makeCuaDriverChildEnvironment({ PATH: "/bin" }, cuaDriverStateEnvironment(stateHome)),
    ).toMatchObject({
      CUA_DRIVER_RS_HOME: stateHome,
      CUA_DRIVER_TELEMETRY_HOME: stateHome,
      CUA_DRIVER_CURSOR_THEME_DIR: cuaDriverCursorThemeDirectory(stateHome),
    });
    // Forwarded through the backend env: the server's MCP proxy and reset
    // commands derive the same overrides from the carried key alone.
    expect(
      makeCuaDriverChildEnvironment({
        PATH: "/bin",
        HOME: "/home/user",
        [CUA_DRIVER_STATE_HOME_KEY]: stateHome,
        CUA_DRIVER_RS_HOME: "/elsewhere",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/user",
      [CUA_DRIVER_STATE_HOME_KEY]: stateHome,
      CUA_DRIVER_RS_HOME: stateHome,
      CUA_DRIVER_TELEMETRY_HOME: stateHome,
      CUA_DRIVER_CURSOR_THEME_DIR: cuaDriverCursorThemeDirectory(stateHome),
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    });
  });

  it("leaves the environment unchanged without a state home", () => {
    expect(makeCuaDriverChildEnvironment({ HOME: "/home/user" })).toEqual({
      HOME: "/home/user",
      CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      CUA_DRIVER_RS_UPDATE_CHECK: "false",
    });
  });
});
