import { describe, expect, it } from "vitest";

import { parseCuaDriverManifest } from "./manifest";
import { CUA_DRIVER_VERSION } from "./release";

describe("parseCuaDriverManifest", () => {
  it("accepts the pinned manifest contract", () => {
    expect(
      parseCuaDriverManifest({
        schema_version: "1",
        binary_version: CUA_DRIVER_VERSION,
        binary_path: "/runtime/cua-driver",
        mcp_invocation: { command: "/runtime/cua-driver", args: ["mcp"] },
      }).binary_version,
    ).toBe(CUA_DRIVER_VERSION);
  });

  it.each(["0.38.1", "0.39.0", "1.0.0", "0.38.1-nightly.20261102"])(
    "accepts compatible release %s",
    (version) => {
      expect(
        parseCuaDriverManifest({
          schema_version: "1",
          binary_version: version,
          binary_path: "/runtime/cua-driver",
          mcp_invocation: { command: "/runtime/cua-driver", args: ["mcp"] },
        }).binary_version,
      ).toBe(version);
    },
  );

  it.each([{ schema_version: "2" }, { binary_version: "" }, { binary_version: null }])(
    "rejects incompatible manifest %j",
    (override) => {
      expect(() =>
        parseCuaDriverManifest({
          schema_version: "1",
          binary_version: "0.39.0",
          binary_path: "/runtime/cua-driver",
          mcp_invocation: { command: "/runtime/cua-driver", args: ["mcp"] },
          ...override,
        }),
      ).toThrow("supported schema 1 contract");
    },
  );

  it("rejects incompatible invocations regardless of version", () => {
    expect(() =>
      parseCuaDriverManifest({
        schema_version: "1",
        binary_version: "0.6.8",
        binary_path: "/runtime/cua-driver",
        mcp_invocation: { command: "/runtime/cua-driver", args: ["serve"] },
      }),
    ).toThrow("invalid MCP invocation");
  });
});
