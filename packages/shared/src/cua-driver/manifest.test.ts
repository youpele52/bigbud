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

  it("rejects mismatched versions and invocations", () => {
    expect(() =>
      parseCuaDriverManifest({
        schema_version: "1",
        binary_version: "0.6.8",
        binary_path: "/runtime/cua-driver",
        mcp_invocation: { command: "/runtime/cua-driver", args: ["serve"] },
      }),
    ).toThrow(`pinned ${CUA_DRIVER_VERSION} contract`);
  });
});
