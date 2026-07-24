import { describe, expect, it } from "vitest";

import {
  CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID,
  CUA_DRIVER_PRODUCTION_HOST_BUNDLE_ID,
  resolveCuaDriverHostBundleId,
} from "./cuaDriver.hostIdentity";

describe("resolveCuaDriverHostBundleId", () => {
  it("uses the stable development app identity outside packaged builds", () => {
    expect(resolveCuaDriverHostBundleId(false)).toBe(CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID);
  });

  it("uses the production app identity in packaged builds", () => {
    expect(resolveCuaDriverHostBundleId(true)).toBe(CUA_DRIVER_PRODUCTION_HOST_BUNDLE_ID);
  });
});
