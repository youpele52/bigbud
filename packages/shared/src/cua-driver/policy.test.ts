import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CUA_DRIVER_DENIED_TOOLS,
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_YAML,
  CUA_DRIVER_REQUIRED_TOOLS,
} from "./policy";

describe("cua-driver policy", () => {
  it("has a stable digest", () => {
    expect(createHash("sha256").update(CUA_DRIVER_POLICY_YAML).digest("hex")).toBe(
      CUA_DRIVER_POLICY_SHA256,
    );
  });

  it("pairs every required and explicitly denied tool with the YAML policy", () => {
    for (const tool of [...CUA_DRIVER_REQUIRED_TOOLS, ...CUA_DRIVER_DENIED_TOOLS]) {
      expect(CUA_DRIVER_POLICY_YAML).toContain(`    - ${tool}\n`);
    }
  });
});
