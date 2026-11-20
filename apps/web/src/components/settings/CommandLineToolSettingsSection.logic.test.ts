import { describe, expect, it } from "vitest";

import { commandLineToolToast } from "./CommandLineToolSettingsSection.logic";

describe("command-line tool toast", () => {
  it("is green when ready, amber when a step remains, red when unavailable", () => {
    expect(
      commandLineToolToast({
        status: "installed",
        launcherPath: "/h/.local/bin/bigbud",
        pathHint: null,
      }),
    ).toMatchObject({ type: "success", title: "Command-line tool installed" });
    expect(
      commandLineToolToast({
        status: "updated",
        launcherPath: "/h/.local/bin/bigbud",
        pathHint: "Add /h/.local/bin to your PATH",
      }),
    ).toMatchObject({
      type: "warning",
      title: "Command-line tool updated",
      description: "Created /h/.local/bin/bigbud. Add /h/.local/bin to your PATH",
    });
    expect(
      commandLineToolToast({ status: "existing-command", existingPath: "/usr/local/bin/bigbud" }),
    ).toMatchObject({ type: "warning", description: "/usr/local/bin/bigbud was left unchanged." });
    expect(commandLineToolToast({ status: "unsupported", reason: "No bundle." })).toMatchObject({
      type: "error",
      description: "No bundle.",
    });
  });
});
