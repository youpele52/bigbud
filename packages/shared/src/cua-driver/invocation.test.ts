import { describe, expect, it } from "vitest";

import {
  cuaDriverEmbeddedEnvironment,
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

  it("rejects a missing embedded host identity", () => {
    expect(() => cuaDriverMcpArguments("/private/run/cua.sock", " ")).toThrow(
      "requires a host bundle ID",
    );
  });
});
