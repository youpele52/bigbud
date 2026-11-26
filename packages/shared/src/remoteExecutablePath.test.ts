import path from "node:path";
import { describe, expect, it } from "vitest";

import { isTrustedRemoteExecutablePath } from "./remoteExecutablePath.ts";

const reference = (value: string) =>
  !value.includes("\0") &&
  value.trim() === value &&
  path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value;

describe("isTrustedRemoteExecutablePath", () => {
  it.each([
    "/usr/local/bin/opencode",
    "/",
    "/opt/opencode/",
    "opencode",
    "./opencode",
    "~/bin/opencode",
    "",
    " /usr/bin/opencode",
    "/usr/bin/opencode ",
    "/usr//bin/opencode",
    "//usr/bin",
    "/usr/./bin",
    "/usr/../bin",
    "/usr/bin/.",
    "/usr/bin/..",
    "/.",
    "/usr/bin/\0opencode",
    "/usr/bin/.opencode",
    "/usr/bin/..opencode",
  ])("matches the node posix rule for %j", (value) => {
    expect(isTrustedRemoteExecutablePath(value)).toBe(reference(value));
  });

  it("rejects non-strings", () => {
    expect(isTrustedRemoteExecutablePath(undefined)).toBe(false);
    expect(isTrustedRemoteExecutablePath(42)).toBe(false);
  });
});
