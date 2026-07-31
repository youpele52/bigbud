import { describe, expect, it } from "vitest";

import {
  providerWorkloadSupport,
  resolveProviderWorkload,
  supportsProviderWorkload,
} from "./providerWorkloadSupport.ts";

describe("providerWorkloadSupport", () => {
  it.each([
    ["codex", true, true, true, true],
    ["claudeAgent", true, true, true, true],
    ["cliProxy", true, false, false, false],
    ["copilot", true, true, true, true],
    ["kilocode", true, true, true, true],
    ["opencode", true, true, true, true],
    ["pi", true, true, true, true],
    ["cursor", true, true, true, false],
    ["devin", true, true, true, false],
  ] as const)(
    "%s declares interactive/text/learning/usage support correctly",
    (provider, interactive, text, learning, usage) => {
      expect(providerWorkloadSupport(provider)).toEqual({
        interactive,
        unattendedTextGeneration: text,
        learning,
        usageAccounting: usage,
      });
    },
  );

  it("never falls back for interactive work", () => {
    const result = resolveProviderWorkload({
      requested: { provider: "cliProxy", model: "default" },
      workload: "interactive",
      availableProviderKinds: ["cliProxy", "codex"],
    });
    expect(result.actual).toEqual({ provider: "cliProxy", model: "default" });
    expect(result.action).toBe("use-requested");
    expect(result.reason).toBeNull();
    expect(supportsProviderWorkload("cliProxy", "interactive")).toBe(true);
  });

  it("resolves unattended work to an enabled supported provider", () => {
    const result = resolveProviderWorkload({
      requested: { provider: "cliProxy", model: "default" },
      workload: "unattendedTextGeneration",
      availableProviderKinds: ["cliProxy", "codex"],
    });
    expect(result.actual).toEqual({ provider: "codex", model: "gpt-5.4-mini" });
    expect(result.action).toBe("fallback");
    expect(result.reason).toContain("cliProxy");
  });

  it("reports an explicit failure when all fallbacks are unavailable", () => {
    const result = resolveProviderWorkload({
      requested: { provider: "cliProxy", model: "default" },
      workload: "unattendedTextGeneration",
      availableProviderKinds: ["cliProxy"],
    });
    expect(result.actual).toBeNull();
    expect(result.action).toBe("reject");
    expect(result.reason).toContain("no supported fallback");
  });
});
