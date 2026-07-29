import { describe, expect, it } from "vitest";

import type { OrchestrationThread, ServerDiscoveryCatalog } from "@bigbud/contracts";

import { readCapabilityGuide, searchCapabilities } from "./CapabilityCatalog.operations.ts";
import { createEffectiveCapabilityCatalog } from "./CapabilityCatalog.dynamic.ts";

const discovery: ServerDiscoveryCatalog = {
  skills: [
    {
      id: "skill-pdf",
      provider: "bigbud",
      name: "pdf",
      displayName: "PDF",
      source: "system",
      description: "Inspect and create PDF documents.",
      sourcePath: "/Users/example/.codex/skills/pdf/SKILL.md",
    },
    {
      id: "skill-claude-only",
      provider: "claudeAgent",
      name: "claude-only",
      source: "user",
      description: "Claude-only workflow.",
    },
  ],
  agents: [
    {
      id: "agent-review",
      provider: "codex",
      name: "reviewer",
      source: "project",
      description: "Review a scoped code change.",
    },
  ],
};

const thread = {
  id: "thread-dynamic-catalog",
  modelSelection: { provider: "codex", model: "gpt-5" },
  activities: [
    {
      kind: "mcp.status.updated",
      payload: {
        status: [
          { name: "github", status: "connected", version: "1.2.3" },
          { name: "notion", status: "needs-auth" },
        ],
      },
    },
  ],
} as unknown as OrchestrationThread;

describe("dynamic capability catalog", () => {
  it("assembles provider-effective skill, agent, and MCP Tracks", () => {
    const catalog = createEffectiveCapabilityCatalog({ discovery, thread });
    const ids = catalog.tracks.map((track) => track.id);

    expect(ids).toContain("skill.bigbud.pdf");
    expect(ids).toContain("agent.codex.reviewer");
    expect(ids).not.toContain("skill.claudeagent.claude-only");
    expect(ids).toContain("mcp.github");
    expect(ids).toContain("mcp.notion");
  });

  it("keeps local source paths out of searchable and readable guidance", () => {
    const catalog = createEffectiveCapabilityCatalog({ discovery, thread });
    const result = searchCapabilities("PDF", catalog);
    const guide = readCapabilityGuide({
      capabilityId: "skill.bigbud.pdf",
      section: "full",
      catalog,
    });

    expect(result.matches[0]?.id).toBe("skill.bigbud.pdf");
    expect(JSON.stringify(result)).not.toContain("/Users/");
    expect(guide.content).not.toContain("/Users/");
  });

  it("changes the revision when MCP status metadata changes", () => {
    const connected = createEffectiveCapabilityCatalog({ discovery, thread });
    const failed = createEffectiveCapabilityCatalog({
      discovery,
      thread: {
        ...thread,
        activities: [
          {
            kind: "mcp.status.updated",
            payload: { status: [{ name: "github", status: "failed" }] },
          },
        ],
      } as unknown as OrchestrationThread,
    });

    expect(failed.revision).not.toBe(connected.revision);
  });
});
