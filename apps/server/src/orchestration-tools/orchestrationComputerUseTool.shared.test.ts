import { describe, expect, it } from "vitest";

import {
  COMPUTER_USE_ACTION_ENUM,
  COPILOT_COMPUTER_USE_PARAMETERS,
  renderPiComputerUseToolSource,
} from "./orchestrationComputerUseTool.shared.ts";

describe("orchestrationComputerUseTool.shared", () => {
  it("includes desktop automation actions used across macOS, Windows, and Linux", () => {
    expect(COMPUTER_USE_ACTION_ENUM).toEqual(
      expect.arrayContaining([
        "check_permissions",
        "doctor",
        "list_apps",
        "launch_app",
        "get_accessibility_tree",
      ]),
    );
    expect(COPILOT_COMPUTER_USE_PARAMETERS.properties.action.enum).toEqual([
      ...COMPUTER_USE_ACTION_ENUM,
    ]);
  });

  it("renders a Pi computer_use tool that posts to the orchestration bridge", () => {
    const source = renderPiComputerUseToolSource();

    expect(source).toContain('name: "computer_use"');
    expect(source).toContain("action: 'computer_use'");
    expect(source).toContain("computerUseAction: args");
  });
});
