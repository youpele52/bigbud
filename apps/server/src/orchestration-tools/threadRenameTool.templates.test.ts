import { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { expect, it } from "vitest";
import { confirmationRequiredResult } from "./ThreadCoordinationConfirmation.result.ts";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import {
  renderOpencodeOrchestrationRuntimeSource,
  renderOpencodeRenameThreadToolSource,
} from "./opencodeThreadOrchestrationTools.ts";
import {
  resolvePiExtensionSource,
  runSource,
  withFixture,
} from "./threadToolTemplates.test.helpers.ts";

it("generated MCP tools/list and actual tools/call expose optional canonical targets without changing the caller", async () => {
  await withFixture(async (config, requests) => {
    const source = renderOrchestrationMcpServerSource(config);
    const messages =
      [
        { id: 1, method: "tools/list", params: {} },
        {
          id: 2,
          method: "tools/call",
          params: {
            name: "rename_thread",
            arguments: { title: "ohno", targetThreadId: "canonical-target" },
          },
        },
        {
          id: 3,
          method: "tools/call",
          params: { name: "rename_thread", arguments: { title: "own" } },
        },
      ]
        .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
        .join("\n") + "\n";
    const responses = (await runSource(source, messages))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const listed = responses
      .find((response) => response.id === 1)
      .result.tools.find((tool: { name: string }) => tool.name === "rename_thread");
    expect(listed.inputSchema).toMatchObject({
      required: ["title"],
      additionalProperties: false,
      properties: { targetThreadId: { type: "string" } },
    });
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "rename",
          threadId: "canonical-caller",
          targetThreadId: "canonical-target",
          title: "ohno",
          invocationId: expect.any(String),
          sourceMessageId: expect.any(String),
        }),
        expect.objectContaining({ action: "rename", threadId: "canonical-caller", title: "own" }),
      ]),
    );
    expect(requests.find((request) => request.title === "own")).not.toHaveProperty(
      "targetThreadId",
    );
  });
});

it("generated Pi extension registers a real defineTool/schema and passes targets and invocation identity", async () => {
  await withFixture(async (config, requests) => {
    const source = resolvePiExtensionSource(renderPiOrchestrationBridgeSource(config));
    await runSource(
      source +
        `
const tools = [];
bigbudOrchestrationBridge({ registerTool(tool) { tools.push(tool); } });
const rename = tools.find(tool => tool.name === 'rename_thread');
if (rename.parameters.properties.targetThreadId.type !== 'string') throw new Error('Missing target schema');
if (rename.parameters.required.includes('targetThreadId')) throw new Error('Target must remain optional');
await rename.execute('owned-call', { title: 'ohno', targetThreadId: 'canonical-target' });
await rename.execute('owned-next-call', { title: 'own' });
`,
    );
    expect(requests[0]).toMatchObject({
      action: "rename",
      threadId: "canonical-caller",
      targetThreadId: "canonical-target",
      invocationId: "owned-call",
      sourceMessageId: expect.any(String),
    });
    expect(requests[1]).toMatchObject({
      action: "rename",
      threadId: "canonical-caller",
      title: "own",
    });
    expect(requests[1]).not.toHaveProperty("targetThreadId");
  });
});

it("legacy OpenCode generated runtime preserves own rename and forwards canonical targets", async () => {
  await withFixture(async (config, requests) => {
    expect(renderOpencodeRenameThreadToolSource()).toContain(
      "targetThreadId: tool.schema.string().optional()",
    );
    await runSource(
      renderOpencodeOrchestrationRuntimeSource(config) +
        `
await renameThread({ title: 'ohno', targetThreadId: 'canonical-target' });
await renameThread({ title: 'own' });
`,
    );
    expect(requests[0]).toMatchObject({
      action: "rename",
      threadId: "canonical-caller",
      targetThreadId: "canonical-target",
    });
    expect(requests[1]).not.toHaveProperty("targetThreadId");
  });
});

const refusal = confirmationRequiredResult({
  code: "BB-BRIDGE00",
  projectId: ProjectId.makeUnsafe("project-b"),
  projectTitle: "B",
  targetIsRemote: false,
});
// The HTTP route spreads the rename result at top level beside `ok`.
const refusingRoute = () => ({ ok: true, ...refusal });

/** Each generated bridge prints the confirmation payload (without `ok`) instead of a rename. */
const expectRefusalText = (text: string) => {
  expect(text).not.toContain("Renamed thread");
  expect(JSON.parse(text)).toEqual(refusal);
};

it("generated MCP, Pi and legacy OpenCode renames print a confirmation_required payload", async () => {
  await withFixture(async (config) => {
    const mcp = (
      await runSource(
        renderOrchestrationMcpServerSource(config),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "rename_thread", arguments: { title: "x", targetThreadId: "foreign" } },
        }) + "\n",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((response) => response.id === 1);
    expectRefusalText(mcp.result.content[0].text);

    const pi = await runSource(
      resolvePiExtensionSource(renderPiOrchestrationBridgeSource(config)) +
        `
const tools = [];
bigbudOrchestrationBridge({ registerTool(tool) { tools.push(tool); } });
const rename = tools.find(tool => tool.name === 'rename_thread');
const result = await rename.execute('refused-call', { title: 'x', targetThreadId: 'foreign' });
process.stdout.write(result.content[0].text);
`,
    );
    expectRefusalText(pi);

    const legacy = await runSource(
      renderOpencodeOrchestrationRuntimeSource(config) +
        `
const result = await renameThread({ title: 'x', targetThreadId: 'foreign' });
process.stdout.write(result.message);
`,
    );
    expectRefusalText(legacy);
  }, refusingRoute);
});
