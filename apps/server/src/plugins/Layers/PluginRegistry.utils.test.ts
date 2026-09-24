import { describe, expect, it } from "vitest";

import { checkPluginGitAvailability, runGit } from "./PluginRegistry.utils";

describe("runGit", () => {
  it("runs through the Node process API", async () => {
    await expect(runGit(["--version"])).resolves.toMatch(/^git version /u);
  });

  it("redacts failed command details to a bounded error", async () => {
    await expect(runGit(["this-command-does-not-exist"])).rejects.toThrow(/^git command failed:/u);
  });
});

describe("checkPluginGitAvailability", () => {
  it("reports a working Git executable", async () => {
    await expect(checkPluginGitAvailability(async () => "git version 2")).resolves.toBe(
      "available",
    );
  });

  it("distinguishes a missing executable from a failed check", async () => {
    await expect(
      checkPluginGitAvailability(async () => {
        throw { code: "ENOENT" };
      }),
    ).resolves.toBe("missing");
    await expect(
      checkPluginGitAvailability(async () => {
        throw { code: "ETIMEDOUT" };
      }),
    ).resolves.toBe("unknown");
  });
});
