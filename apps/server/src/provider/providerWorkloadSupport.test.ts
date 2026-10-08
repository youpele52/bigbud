import { describe, expect, it } from "vitest";

import {
  providerWorkloadSupport,
  resolveProviderWorkload,
  supportsProviderWorkload,
  supportsScheduledLearning,
} from "./providerWorkloadSupport.ts";

describe("providerWorkloadSupport", () => {
  it("declares restricted V2 interactive/accounting support without claiming unattended coding or migrating accounting", () => {
    expect(providerWorkloadSupport("opencodeV2")).toEqual({
      interactive: true,
      usageAccounting: true,
      learning: false,
      unattendedTextGeneration: false,
    });
    const requested = {
      provider: "opencodeV2",
      subProviderID: "synthetic",
      model: "synthetic",
    } as const;
    expect(
      resolveProviderWorkload({
        requested,
        workload: "interactive",
        availableProviderKinds: ["opencodeV2"],
      }).actual,
    ).toEqual(requested);
    expect(
      resolveProviderWorkload({
        requested,
        workload: "usageAccounting",
        availableProviderKinds: ["codex"],
      }).action,
    ).toBe("reject");
    expect(
      resolveProviderWorkload({
        requested,
        workload: "unattendedTextGeneration",
        availableProviderKinds: ["codex"],
      }),
    ).toMatchObject({ requested, actual: { provider: "codex" }, action: "fallback" });
  });
  it("schedules V2 learning only with an explicit durable adapter hook, without changing public workload or other providers", () => {
    expect(supportsScheduledLearning("opencodeV2")).toBe(false);
    expect(supportsScheduledLearning("opencodeV2", true)).toBe(true);
    expect(supportsScheduledLearning("cliProxy", true)).toBe(false);
    expect(supportsScheduledLearning("codex")).toBe(true);
    expect(supportsProviderWorkload("opencodeV2", "learning")).toBe(false);
    expect(supportsProviderWorkload("opencodeV2", "unattendedTextGeneration")).toBe(false);
  });
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
