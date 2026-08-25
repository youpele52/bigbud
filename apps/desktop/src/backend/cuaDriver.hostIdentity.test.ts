import { describe, expect, it } from "vitest";

import {
  CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID,
  resolveCuaDriverHostBundleId,
} from "./cuaDriver.hostIdentity";

describe("resolveCuaDriverHostBundleId", () => {
  it("uses the stable development app identity outside packaged builds", () => {
    expect(resolveCuaDriverHostBundleId(false, "ai.bigbud.desktop.beta")).toBe(
      CUA_DRIVER_DEVELOPMENT_HOST_BUNDLE_ID,
    );
  });

  it.each([
    "ai.bigbud.desktop",
    "ai.bigbud.desktop.beta",
    "ai.bigbud.desktop.preview",
    "ai.bigbud.desktop.nightly",
  ])("uses packaged channel identity %s", (appId) => {
    expect(resolveCuaDriverHostBundleId(true, appId)).toBe(appId);
  });
});
