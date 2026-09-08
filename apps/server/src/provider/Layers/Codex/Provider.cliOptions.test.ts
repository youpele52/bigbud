import { describe, expect, it } from "vitest";

import { shouldEnableCodexCliFastMode } from "./Provider.cliOptions";

describe("shouldEnableCodexCliFastMode", () => {
  it("enables explicit fast mode for supported built-in models", () => {
    expect(
      shouldEnableCodexCliFastMode({
        model: "gpt-5.4",
        options: { fastMode: true },
        customModels: [],
      }),
    ).toBe(true);
  });

  it("preserves explicit fast mode for configured custom models", () => {
    expect(
      shouldEnableCodexCliFastMode({
        model: " custom-codex ",
        options: { fastMode: true },
        customModels: [" custom-codex "],
      }),
    ).toBe(true);
  });

  it("does not enable fast mode for unconfigured unsupported models", () => {
    expect(
      shouldEnableCodexCliFastMode({
        model: "unknown-codex",
        options: { fastMode: true },
        customModels: [],
      }),
    ).toBe(false);
  });

  it("requires fast mode to be explicitly enabled", () => {
    expect(
      shouldEnableCodexCliFastMode({
        model: "custom-codex",
        options: undefined,
        customModels: ["custom-codex"],
      }),
    ).toBe(false);
  });
});
