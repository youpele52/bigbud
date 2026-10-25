import { expect, it } from "vitest";
import { v2ApplicationConfigKey } from "./Application.configKey.ts";

it("retains inactive isolated overrides without invalidating shared identity", () => {
  const value = {
    connectionMode: "shared" as const,
    binaryPath: "/saved/binary",
    profileRoot: "/saved/profile",
    serviceFile: "/native/service.json",
  };
  const changed = { ...value, binaryPath: "/other/binary", profileRoot: "/other/profile" };
  expect(v2ApplicationConfigKey(value)).toBe(v2ApplicationConfigKey(changed));
  expect(v2ApplicationConfigKey(value)).not.toBe(
    v2ApplicationConfigKey({ ...value, serviceFile: "/other/service.json" }),
  );
  expect(v2ApplicationConfigKey({ ...value, connectionMode: "isolated" })).not.toBe(
    v2ApplicationConfigKey({ ...changed, connectionMode: "isolated" }),
  );
  expect(value.binaryPath).toBe("/saved/binary");
});
