import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import { createCodexThreadOrchestrationDynamicTools } from "./codexThreadDynamicTools.ts";
import { createCopilotThreadOrchestrationTools } from "./copilotThreadOrchestrationTools.ts";
import { AGENT_WORKSPACE_TOOL_NAMES } from "./AgentWorkspaceTools.ts";
import { AGENT_WORKSPACE_TOOL_SPECS } from "./AgentWorkspaceToolSpecs.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { ThreadToolRequest } from "../ws/http.threadTools.schema.ts";

const config = { host: "127.0.0.1", port: 1, threadId: "thread-1", token: "secret" };

describe("agent workspace provider parity", () => {
  it("exposes every safe tool and no deletion tool across all transport families", () => {
    const codex = createCodexThreadOrchestrationDynamicTools().map(({ name }) => name);
    const copilot = createCopilotThreadOrchestrationTools({
      workspace: async () => ({}),
      renameThread: async () => ({ title: "x" }),
      archiveThread: async () => {},
      getThreadStatus: async () => ({}),
      listPinnedThreads: async () => ({}),
      setThreadPinned: async () => ({}),
      computerUse: async () => ({}),
      browser: async () => ({}),
      createThread: async () => ({}),
    }).map(({ name }) => name);
    const mcp = renderOrchestrationMcpServerSource(config);
    const pi = renderPiOrchestrationBridgeSource(config);

    for (const name of AGENT_WORKSPACE_TOOL_NAMES) {
      expect(codex).toContain(name);
      expect(copilot).toContain(name);
      expect(mcp).toContain(`"${name}"`);
      expect(pi).toContain(`"${name}"`);
    }
    for (const surface of [codex.join(" "), copilot.join(" "), mcp, pi]) {
      expect(surface).not.toMatch(/delete_(note|kanban|card)/);
    }
  });

  it("rejects fabricated deletion through the authenticated HTTP bridge schema", () => {
    const decode = Schema.decodeUnknownSync(ThreadToolRequest);
    expect(() =>
      decode({
        action: "workspace",
        workspaceTool: "delete_note",
        workspaceArguments: { noteId: "note-1" },
      }),
    ).toThrow();
    expect(() => decode({ action: "delete_note", noteId: "note-1" })).toThrow();
  });

  it("requires explicit creation scope and constrains optional list scope", () => {
    for (const name of ["create_note", "create_kanban_card"]) {
      const spec = AGENT_WORKSPACE_TOOL_SPECS.find((candidate) => candidate.name === name)!;
      expect(spec.inputSchema.required).toContain("scope");
      expect(spec.inputSchema.properties).toMatchObject({
        scope: { enum: ["global", "project"] },
      });
    }
    for (const name of ["list_notes", "list_kanban_cards"]) {
      const spec = AGENT_WORKSPACE_TOOL_SPECS.find((candidate) => candidate.name === name)!;
      expect(spec.inputSchema.required).not.toContain("scope");
      expect(spec.inputSchema.properties).toMatchObject({
        scope: { enum: ["all", "global", "project"], default: "all" },
      });
    }
  });
});
