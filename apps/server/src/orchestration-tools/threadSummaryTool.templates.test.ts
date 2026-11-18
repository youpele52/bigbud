import { expect, it } from "vitest";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import {
  renderOpencodeOrchestrationRuntimeSource,
  renderOpencodeSummaryToolSource,
} from "./opencodeThreadOrchestrationTools.ts";
import {
  resolvePiExtensionSource,
  runSource,
  withFixture,
} from "./threadToolTemplates.test.helpers.ts";

it("generated MCP lists summary-only arguments and never forwards caller or target overrides", async () => {
  await withFixture(async (config, requests) => {
    const messages =
      [
        { id: 1, method: "tools/list", params: {} },
        ...[
          { summary: "Own summary" },
          { summary: "Own summary", threadId: "foreign" },
          { summary: "Own summary", targetThreadId: "foreign" },
          { summary: "Own summary", callerThreadId: "foreign" },
        ].map((args, index) => ({
          id: index + 2,
          method: "tools/call",
          params: { name: "set_elevator_summary", arguments: args },
        })),
      ]
        .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
        .join("\n") + "\n";
    const responses = (await runSource(renderOrchestrationMcpServerSource(config), messages))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      responses
        .find((r) => r.id === 1)
        .result.tools.find((tool: { name: string }) => tool.name === "set_elevator_summary")
        .inputSchema,
    ).toMatchObject({ required: ["summary"], additionalProperties: false });
    expect(requests).toEqual([
      expect.objectContaining({
        action: "set_elevator_summary",
        threadId: "canonical-caller",
        summary: "Own summary",
        invocationId: expect.any(String),
        sourceMessageId: expect.any(String),
      }),
    ]);
    for (const id of [3, 4, 5]) {
      const response = responses.find((r) => r.id === id);
      expect(Boolean(response.error || response.result?.isError)).toBe(true);
    }
  });
});

it("generated Pi summary binds trusted identity and rejects every target override", async () => {
  await withFixture(async (config, requests) => {
    await runSource(
      resolvePiExtensionSource(renderPiOrchestrationBridgeSource(config)) +
        `
const tools = [];
bigbudOrchestrationBridge({ registerTool(tool) { tools.push(tool); } });
const summary = tools.find(tool => tool.name === 'set_elevator_summary');
if (summary.parameters.additionalProperties !== false) throw new Error('Open arguments');
await summary.execute('summary-call', { summary: 'Own summary' });
for (const key of ['threadId', 'targetThreadId', 'callerThreadId']) {
  let rejected = false;
  try { await summary.execute('bad-call', { summary: 'Own summary', [key]: 'foreign' }); }
  catch { rejected = true; }
  if (!rejected) throw new Error('Target accepted');
}
`,
    );
    expect(requests).toEqual([
      expect.objectContaining({
        action: "set_elevator_summary",
        threadId: "canonical-caller",
        summary: "Own summary",
        invocationId: "summary-call",
        sourceMessageId: expect.any(String),
      }),
    ]);
  });
});

it("legacy OpenCode summary uses the owned runtime and requires native invocation identity", async () => {
  await withFixture(async (config, requests) => {
    // Execute the actual generated tool body with an owned fixture tool/schema, not a vendor session.
    const toolSource = renderOpencodeSummaryToolSource()
      .replace(
        'import { tool } from "@opencode-ai/plugin";',
        "const tool = Object.assign(value => value, { schema: { string: () => ({ min: () => ({}) }) } });",
      )
      .replace(
        'import * as runtime from "../../.bigbud/opencode-orchestration-runtime.ts";',
        "const runtime = { setElevatorSummary };",
      )
      .replace("export default tool(", "const summaryTool = tool(");
    await runSource(
      renderOpencodeOrchestrationRuntimeSource(config) +
        toolSource +
        `
const context = { sessionID: 'session', messageID: 'message', callID: 'call' };
await summaryTool.execute({ summary: 'Own summary' }, context);
for (const args of [{ summary: 'Own summary', targetThreadId: 'foreign' }, { summary: 'Own summary', threadId: 'foreign' }]) {
  let rejected = false;
  try { await summaryTool.execute(args, context); } catch { rejected = true; }
  if (!rejected) throw new Error('Target accepted');
}
let rejected = false;
try { await summaryTool.execute({ summary: 'Own summary' }, {}); } catch { rejected = true; }
if (!rejected) throw new Error('Missing identity accepted');
`,
    );
    expect(requests).toEqual([
      {
        action: "set_elevator_summary",
        threadId: "canonical-caller",
        summary: "Own summary",
        invocationId: '["session","message","call"]',
        sourceMessageId: '["session","message","call"]',
      },
    ]);
  });
});
