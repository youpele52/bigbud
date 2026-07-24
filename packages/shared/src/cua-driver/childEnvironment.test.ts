import { describe, expect, it } from "vitest";

import { makeCuaDriverChildEnvironment } from "./childEnvironment";

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
});
