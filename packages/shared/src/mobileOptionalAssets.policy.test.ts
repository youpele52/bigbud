import { expect, it } from "vitest";
import { claimMobileAssetPath, validateMobileAssetPath } from "./mobileOptionalAssets.policy.ts";

it.each([
  "../escape.js",
  "/escape.js",
  ".env",
  "foo\\bar.js",
  "credentials.json",
  "debug.map",
  "secret.txt",
])("shares the same unsafe/static-private rejection for %s", (path) => {
  expect(() => validateMobileAssetPath(path, false)).toThrow();
});
it("normalizes directory terminators and rejects all case collisions consistently", () => {
  const seen = new Set<string>();
  expect(claimMobileAssetPath("Static/", true, seen)).toBe("Static");
  expect(() => claimMobileAssetPath("static", true, seen)).toThrow(/case-colliding/);
  claimMobileAssetPath("Static/App.js", false, seen);
  expect(() => claimMobileAssetPath("static/app.JS", false, seen)).toThrow(/case-colliding/);
});
it("accepts exactly 32 directory levels and a file beneath them", () => {
  expect(validateMobileAssetPath("a/".repeat(32), true)).toBe("a/".repeat(31) + "a");
  expect(validateMobileAssetPath("a/".repeat(32) + "app.js", false)).toContain("app.js");
  expect(() => validateMobileAssetPath("a/".repeat(33), true)).toThrow();
  expect(() => validateMobileAssetPath("a/".repeat(33) + "app.js", false)).toThrow();
});
