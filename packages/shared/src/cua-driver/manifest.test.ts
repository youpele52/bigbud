import { describe, expect, it } from "vitest";

import { parseCuaDriverManifest } from "./manifest";

describe("parseCuaDriverManifest", () => {
  it("accepts the pinned manifest contract", () => {
    expect(
      parseCuaDriverManifest({
        schema_version: "1",
        binary_version: "0.9.1",
        binary_path: "/runtime/cua-driver",
        mcp_invocation: { command: "/runtime/cua-driver", args: ["mcp"] },
      }).binary_version,
    ).toBe("0.9.1");
  });

  it("rejects mismatched versions and invocations", () => {
    expect(() =>
      parseCuaDriverManifest({
        schema_version: "1",
        binary_version: "0.6.8",
        binary_path: "/runtime/cua-driver",
        mcp_invocation: { command: "/runtime/cua-driver", args: ["serve"] },
      }),
    ).toThrow("pinned 0.9.1 contract");
  });
});
