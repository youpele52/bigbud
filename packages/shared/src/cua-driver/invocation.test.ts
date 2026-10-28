import { describe, expect, it } from "vitest";

import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverHonoursPidFile,
  cuaDriverMcpArguments,
  cuaDriverServeArguments,
} from "./invocation";

describe("cua-driver embedded invocation", () => {
  it.each(["ai.bigbud.desktop", "ai.bigbud.desktop.dev"])(
    "uses one private endpoint and the explicit host identity %s",
    (hostBundleId) => {
      const socketPath = "/private/run/cua.sock";

      expect(cuaDriverEmbeddedEnvironment(socketPath, hostBundleId)).toEqual({
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: hostBundleId,
        CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS: "300",
        CUA_DRIVER_RS_RECORDING_IDLE_TTL_SECS: "60",
        BIGBUD_CUA_ENDPOINT: socketPath,
        BIGBUD_CUA_DRIVER_SOCKET: socketPath,
        BIGBUD_CUA_HOST_BUNDLE_ID: hostBundleId,
      });
      expect(cuaDriverMcpArguments(socketPath, hostBundleId)).toEqual([
        "mcp",
        "--embedded",
        "--socket",
        socketPath,
        "--host-bundle-id",
        hostBundleId,
      ]);
      expect(cuaDriverServeArguments(socketPath, hostBundleId)).toEqual([
        "serve",
        "--embedded",
        "--socket",
        socketPath,
        "--host-bundle-id",
        hostBundleId,
      ]);
    },
  );

  it("adds a private pid file only when asked, keeping the plain argv byte-identical", () => {
    const plain = cuaDriverServeArguments("/private/run/cua.sock", "ai.bigbud.desktop");
    expect(cuaDriverServeArguments("/private/run/cua.sock", "ai.bigbud.desktop", {})).toEqual(
      plain,
    );
    expect(
      cuaDriverServeArguments("/private/run/cua.sock", "ai.bigbud.desktop", {
        pidFile: "/private/run/cua.pid",
      }),
    ).toEqual([...plain, "--pid-file", "/private/run/cua.pid"]);
    expect(
      cuaDriverServeArguments("/private/run/cua.sock", "ai.bigbud.desktop", {
        pidFile: "/private/run/cua.pid",
        cursorTheme: "ai.bigbud.agent-cursor",
      }),
    ).toEqual([
      ...plain,
      "--pid-file",
      "/private/run/cua.pid",
      "--cursor-theme",
      "ai.bigbud.agent-cursor",
    ]);
  });

  it("honours --pid-file for 0.38.0 only (0.9.1 parses but ignores it)", () => {
    expect(cuaDriverHonoursPidFile("0.38.0")).toBe(true);
    expect(cuaDriverHonoursPidFile("0.9.1")).toBe(false);
    expect(cuaDriverHonoursPidFile(null)).toBe(false);
    expect(cuaDriverHonoursPidFile(undefined)).toBe(false);
    expect(cuaDriverHonoursPidFile("0.38.1")).toBe(false); // unlisted: decided when pinned
  });

  it("rejects a missing embedded host identity", () => {
    expect(() => cuaDriverMcpArguments("/private/run/cua.sock", " ")).toThrow(
      "requires a host bundle ID",
    );
  });
});
