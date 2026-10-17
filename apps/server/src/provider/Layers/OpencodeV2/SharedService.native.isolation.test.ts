import { expect, it } from "vitest";
import {
  requireV2NativeIsolation,
  v2NativeFixtureEnvironment,
  type V2NativeIsolationApproval,
} from "./SharedService.native.isolation.fixture.ts";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";

it("an environment assertion, synthetic version or private HOME cannot authorize a retail launch", async () => {
  await expect(requireV2NativeIsolation("/never-read-or-execute/opencode", "true")).rejects.toThrow(
    "approved clean macOS ARM64 environment",
  );
  await expect(
    requireV2NativeIsolation("/never-read-or-execute/opencode", "synthetic-approval"),
  ).rejects.toThrow("HOME/XDG alone is not isolation");
});

it("native environment construction derives owned roots and discards host credentials/config/PATH/temp even before provenance is authorized", () => {
  const approval = {
    fixtureRoot: "/synthetic/owned",
    controlledPath: "/usr/bin:/bin",
  } as V2NativeIsolationApproval;
  const profile = "/synthetic/owned/profile";
  const env = v2NativeFixtureEnvironment(approval, profile, "/synthetic/owned/workspace", {
    HOME: "/foreign/home",
    XDG_CONFIG_HOME: "/foreign/config",
    OPENCODE_CONFIG_DIR: "/foreign/opencode",
    PATH: "/foreign/path",
    TMPDIR: "/foreign/tmp",
    NODE_OPTIONS: "--require=foreign",
    ANTHROPIC_API_KEY: "synthetic-secret",
  });
  expect(env).toMatchObject({
    HOME: profile,
    XDG_CONFIG_HOME: `${profile}/config`,
    OPENCODE_CONFIG_DIR: `${profile}/config/opencode`,
    PATH: "/usr/bin:/bin",
    TMPDIR: profile,
  });
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(() =>
    v2NativeFixtureEnvironment(approval, profile, "/synthetic/owned/workspace", {
      OPENCODE_DB: "/foreign/db",
    }),
  ).toThrow("database escaped");
});

it("the shared fixture refuses before profile/vendor setup or native executable inspection", async () => {
  await expect(sharedServiceNativeFixture("/never-read-or-execute/opencode")).rejects.toThrow(
    "before any retail launch",
  );
});
