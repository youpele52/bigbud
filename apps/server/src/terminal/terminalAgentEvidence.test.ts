import { describe, expect, it } from "vitest";
import { createTerminalAgentEvidenceResolver } from "./terminalAgentEvidence.ts";
import { TERMINAL_AGENTS, type TerminalAgentDescriptor } from "./terminalAgents.ts";
import { createTerminalTaskTitleResolver } from "./terminalTaskTitle.ts";
import { agentFromProcessCommand } from "./Layers/Manager.agentDetection.ts";

const fictional: TerminalAgentDescriptor = {
  id: "nebula-worker",
  names: ["Nebula CLI", "Nebula Worker"],
  titlePrefixes: ["◇ "],
};
const noAgent = { foregroundAgent: null } as const;

describe("provider-neutral terminal evidence adapters", () => {
  it("adds a fictional terminal-only agent through metadata without changing naming code or ProviderKind", () => {
    const original = createTerminalTaskTitleResolver();
    const extended = createTerminalTaskTitleResolver([...TERMINAL_AGENTS, fictional]);
    expect(original("Nebula CLI: Repair authentication flow", noAgent)).toBeNull();
    for (const raw of [
      "Nebula CLI: Repair authentication flow",
      "Repair authentication flow - Nebula Worker",
      "◇ Repair authentication flow",
    ]) {
      expect(extended(raw, noAgent)).toBe("Repair authentication flow");
    }
    expect(extended("Repair authentication flow", noAgent)).toBeNull();
    expect(agentFromProcessCommand("nebula-worker --task fix-auth")).toBeNull();
  });

  it("returns explicit evidence provenance rather than promoting arbitrary task-like titles", () => {
    const resolver = createTerminalAgentEvidenceResolver([fictional]);
    expect(resolver.resolve("Review authentication flow", null)).toBeNull();
    expect(resolver.resolve("Nebula CLI: Review authentication flow", null)).toEqual({
      source: "native-title",
      agent: fictional,
      title: "Review authentication flow",
    });
    expect(resolver.resolve("Review authentication flow", fictional)).toEqual({
      source: "foreground-agent",
      agent: fictional,
      title: "Review authentication flow",
    });
  });

  it("accepts verified foreground evidence for an agent absent from the catalog", () => {
    const resolve = createTerminalTaskTitleResolver([]);
    const context = { foregroundAgent: fictional };
    expect(resolve("Review authentication flow", context)).toBe("Review authentication flow");
    expect(resolve("Nebula CLI: Review authentication flow", context)).toBe(
      "Review authentication flow",
    );
    expect(resolve("Nebula CLI", context)).toBeNull();
    expect(resolve("Nebula CLI v1.2.3", context)).toBeNull();
    expect(resolve("git status", context)).toBeNull();
    expect(resolve("Working (20s)", context)).toBeNull();
    expect(resolve("Review authentication flow", noAgent)).toBeNull();
    expect(
      resolve("Review authentication flow", { foregroundAgent: { id: "", names: [] } }),
    ).toBeNull();
  });

  it("applies the same shell, generic, status, and cwd protections to new adapters", () => {
    const resolve = createTerminalTaskTitleResolver([fictional]);
    for (const title of [
      "bun dev",
      "git status",
      "Ready for input",
      "Thinking (20s)",
      "Nebula CLI",
      "Nebula CLI v1.0",
      "/Users/me/my project",
    ]) {
      expect(resolve(`Nebula CLI: ${title}`, noAgent)).toBeNull();
    }
    expect(
      resolve("◇ my project", { ...noAgent, directories: ["/Users/me/my project"] }),
    ).toBeNull();
  });

  it("treats adapter names as literal labels, never executable regular expressions", () => {
    const resolve = createTerminalTaskTitleResolver([{ id: "literal", names: ["Nebula [CLI]+"] }]);
    expect(resolve("Nebula [CLI]+: Fix authentication flow", noAgent)).toBe(
      "Fix authentication flow",
    );
    expect(resolve("Nebula C: Fix authentication flow", noAgent)).toBeNull();
    const empty = createTerminalTaskTitleResolver([
      { id: "empty", names: ["", "  "], titlePrefixes: [""] },
    ]);
    expect(empty("Anything: Fix authentication flow", noAgent)).toBeNull();
  });

  it("preserves all shipped terminal-only adapters without advertising native backend support", () => {
    const resolve = createTerminalTaskTitleResolver();
    const terminalOnly = TERMINAL_AGENTS.filter((agent) => !agent.provider);
    expect(terminalOnly.length).toBeGreaterThan(0);
    for (const agent of terminalOnly) {
      for (const name of agent.names) {
        expect(resolve(`${name}: Review authentication flow`, noAgent)).toBe(
          "Review authentication flow",
        );
      }
    }
  });

  it("shares supported executable and wrapper metadata with process detection", () => {
    for (const agent of TERMINAL_AGENTS.filter((entry) => entry.provider)) {
      for (const executable of agent.executables ?? []) {
        expect(agentFromProcessCommand(`/usr/local/bin/${executable} --help`)).toBe(agent.provider);
      }
      for (const script of agent.scriptPaths ?? []) {
        expect(agentFromProcessCommand(`node /workspace${script}cli.js`)).toBe(agent.provider);
        expect(agentFromProcessCommand(`rg ${script} README.md`)).toBeNull();
      }
    }
  });
});
