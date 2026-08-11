import { describe, expect, it } from "vitest";

import { runGit } from "./PluginRegistry.utils";

describe("runGit", () => {
  it("runs through the Node process API", async () => {
    await expect(runGit(["--version"])).resolves.toMatch(/^git version /u);
  });

  it("redacts failed command details to a bounded error", async () => {
    await expect(runGit(["this-command-does-not-exist"])).rejects.toThrow(/^git command failed:/u);
  });
});
