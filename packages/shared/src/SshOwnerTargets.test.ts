import { describe, expect, it } from "vitest";

import { isSshOwnerReleaseTarget, SSH_OWNER_TARGETS } from "./SshOwnerTargets.ts";

describe("SSH owner U4 targets", () => {
  it("lists exactly the U4 cells", () => {
    expect(SSH_OWNER_TARGETS.map(({ platform, arch }) => `${platform}-${arch}`)).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
    ]);
  });

  it("refuses Windows arm64, unknown targets and undefined", () => {
    expect(isSshOwnerReleaseTarget({ platform: "win32", arch: "arm64" })).toBe(false);
    expect(isSshOwnerReleaseTarget({ platform: "linux", arch: "ia32" })).toBe(false);
    expect(isSshOwnerReleaseTarget(undefined)).toBe(false);
    expect(isSshOwnerReleaseTarget({ platform: "linux", arch: "arm64", extra: 1 })).toBe(true);
  });
});
