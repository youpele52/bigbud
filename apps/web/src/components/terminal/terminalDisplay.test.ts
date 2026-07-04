import { describe, expect, it } from "vitest";

import {
  buildTerminalLabelMap,
  resolveTerminalBaseLabel,
  resolveTerminalProvider,
} from "./terminalDisplay";

describe("terminalDisplay", () => {
  it("prefers the project name for the terminal label", () => {
    expect(
      resolveTerminalBaseLabel({
        projectName: "BigBud",
        cwd: "/Users/youpele/DevWorld/bigbud",
      }),
    ).toBe("BigBud");
  });

  it("falls back to the cwd basename when no project name is available", () => {
    expect(
      resolveTerminalBaseLabel({
        projectName: null,
        cwd: "/Users/youpele/DevWorld/bigbud",
      }),
    ).toBe("bigbud");

    expect(
      resolveTerminalBaseLabel({
        projectName: "",
        cwd: "C:\\Users\\youpele\\DevWorld\\bigbud",
      }),
    ).toBe("bigbud");
  });

  it("falls back to Terminal when neither project nor cwd are available", () => {
    expect(
      resolveTerminalBaseLabel({
        projectName: null,
        cwd: null,
      }),
    ).toBe("Terminal");
  });

  it("numbers additional terminal labels after the base label", () => {
    expect([
      ...buildTerminalLabelMap(["default", "terminal-2", "terminal-3"], "bigbud").entries(),
    ]).toEqual([
      ["default", "bigbud"],
      ["terminal-2", "bigbud 2"],
      ["terminal-3", "bigbud 3"],
    ]);
  });

  it("prefers the active session provider and falls back to the model provider", () => {
    expect(
      resolveTerminalProvider({
        sessionProvider: "codex",
        modelProvider: "claudeAgent",
      }),
    ).toBe("codex");

    expect(
      resolveTerminalProvider({
        sessionProvider: null,
        modelProvider: "claudeAgent",
      }),
    ).toBe("claudeAgent");

    expect(
      resolveTerminalProvider({
        sessionProvider: null,
        modelProvider: null,
      }),
    ).toBeNull();
  });
});
