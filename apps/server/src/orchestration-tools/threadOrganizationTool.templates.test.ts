import { expect, it } from "vitest";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import {
  resolvePiExtensionSource,
  runSource,
  withFixture,
} from "./threadToolTemplates.test.helpers.ts";

it("generated MCP move_thread and snooze_thread keep the caller and forward targets", async () => {
  await withFixture(async (config, requests) => {
    const messages =
      [
        { id: 1, method: "tools/list", params: {} },
        {
          id: 2,
          method: "tools/call",
          params: { name: "move_thread", arguments: { state: "done" } },
        },
        {
          id: 3,
          method: "tools/call",
          params: {
            name: "snooze_thread",
            arguments: { minutes: 30, targetThreadId: "canonical-target" },
          },
        },
      ]
        .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
        .join("\n") + "\n";
    const responses = (await runSource(renderOrchestrationMcpServerSource(config), messages))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const tools = responses.find((response) => response.id === 1).result.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(tools.find((tool) => tool.name === "move_thread")?.inputSchema).toMatchObject({
      required: ["state"],
      properties: { state: { enum: ["present", "needs-you", "later", "done"] } },
    });
    expect(tools.find((tool) => tool.name === "snooze_thread")?.inputSchema).toMatchObject({
      required: ["minutes"],
      properties: { minutes: { minimum: 2, maximum: 1440 } },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        action: "move",
        threadId: "canonical-caller",
        organizationState: "done",
        invocationId: expect.any(String),
      }),
      expect.objectContaining({
        action: "snooze",
        threadId: "canonical-caller",
        durationMinutes: 30,
        targetThreadId: "canonical-target",
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("targetThreadId");
  });
});

it("generated Pi extension registers move_thread and snooze_thread with invocation identity", async () => {
  await withFixture(async (config, requests) => {
    await runSource(
      resolvePiExtensionSource(renderPiOrchestrationBridgeSource(config)) +
        `
const tools = [];
bigbudOrchestrationBridge({ registerTool(tool) { tools.push(tool); } });
await tools.find(tool => tool.name === 'move_thread').execute('owned-move', { state: 'later' });
await tools.find(tool => tool.name === 'snooze_thread').execute('owned-snooze', { minutes: 60, targetThreadId: 'canonical-target' });
`,
    );
    expect(requests).toEqual([
      expect.objectContaining({
        action: "move",
        threadId: "canonical-caller",
        organizationState: "later",
        invocationId: "owned-move",
      }),
      expect.objectContaining({
        action: "snooze",
        durationMinutes: 60,
        targetThreadId: "canonical-target",
        invocationId: "owned-snooze",
      }),
    ]);
  });
});
