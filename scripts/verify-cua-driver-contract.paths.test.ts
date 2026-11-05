import { describe, expect, it } from "vitest";

import { CUA_DRIVER_VERSION } from "@bigbud/shared/cua-driver/release";

import {
  cuaDriverContractFixtureDir,
  cuaDriverContractReadme,
  cuaDriverContractReadmeTarget,
} from "./verify-cua-driver-contract.paths.ts";

describe("verify-cua-driver-contract fixture paths", () => {
  it("derives the fixture folder from the pinned version instead of a fixed 0.9.1 folder", () => {
    expect(cuaDriverContractFixtureDir("/repo", CUA_DRIVER_VERSION)).toBe(
      `/repo/scripts/fixtures/cua-driver/${CUA_DRIVER_VERSION}`,
    );
    expect(cuaDriverContractFixtureDir("/repo", "0.38.0")).toBe(
      "/repo/scripts/fixtures/cua-driver/0.38.0",
    );
  });

  it("names the captured version in the README", () => {
    expect(cuaDriverContractReadme("0.38.0", "darwin", "arm64")).toMatch(
      /^# cua-driver 0\.38\.0 contract\n\nCaptured by .* on darwin\/arm64\./,
    );
  });

  it("never overwrites an existing fixture README (the 0.38.0 provenance record)", () => {
    const existing = new Set(["/repo/scripts/fixtures/cua-driver/0.38.0/README.md"]);
    const exists = (path: string) => existing.has(path);
    expect(cuaDriverContractReadmeTarget("/repo/scripts/fixtures/cua-driver/0.38.0", exists)).toBe(
      null,
    );
    expect(cuaDriverContractReadmeTarget("/repo/scripts/fixtures/cua-driver/0.9.1", exists)).toBe(
      "/repo/scripts/fixtures/cua-driver/0.9.1/README.md",
    );
  });
});
