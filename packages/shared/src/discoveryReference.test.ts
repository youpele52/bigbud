import { describe, expect, it } from "vitest";
import type { ServerDiscoveredAgent } from "@bigbud/contracts/server/server.providers.ts";
import { resolveDiscoveryEntry } from "./discoveryReference";

function entry(
  provider: ServerDiscoveredAgent["provider"],
  source: ServerDiscoveredAgent["source"] = "user",
): ServerDiscoveredAgent {
  return { id: `${provider}:${source}`, name: "review", provider, source };
}

describe("resolveDiscoveryEntry", () => {
  it("uses the active provider rather than the first same-name entry", () => {
    const preferred = entry("opencode");
    expect(
      resolveDiscoveryEntry({
        entries: [entry("codex"), preferred],
        name: " Review ",
        preferredProvider: "opencode",
      }),
    ).toEqual({ status: "resolved", entry: preferred });
  });

  it("preserves catalog order within the preferred provider, including project precedence", () => {
    const project = entry("opencode", "project");
    expect(
      resolveDiscoveryEntry({
        entries: [project, entry("opencode")],
        name: "review",
        preferredProvider: "opencode",
      }),
    ).toEqual({ status: "resolved", entry: project });
  });

  it("uses bundled bigbud guidance before the active provider", () => {
    const bundled = entry("bigbud", "system");
    expect(
      resolveDiscoveryEntry({
        entries: [entry("opencode"), bundled],
        name: "review",
        preferredProvider: "opencode",
      }),
    ).toEqual({ status: "resolved", entry: bundled });
  });

  it("does not guess between multiple bundled entries", () => {
    expect(
      resolveDiscoveryEntry({
        entries: [entry("bigbud"), entry("bigbud", "system"), entry("opencode")],
        name: "review",
        preferredProvider: "opencode",
      }).status,
    ).toBe("ambiguous");
  });

  it("uses a sole fallback but keeps unrelated providers ambiguous", () => {
    const fallback = entry("codex");
    expect(
      resolveDiscoveryEntry({ entries: [fallback], name: "review", preferredProvider: "opencode" }),
    ).toEqual({ status: "resolved", entry: fallback });
    expect(
      resolveDiscoveryEntry({
        entries: [fallback, entry("claudeAgent")],
        name: "review",
        preferredProvider: "opencode",
      }).status,
    ).toBe("ambiguous");
    expect(
      resolveDiscoveryEntry({ entries: [], name: "review", preferredProvider: undefined }).status,
    ).toBe("missing");
  });
});
