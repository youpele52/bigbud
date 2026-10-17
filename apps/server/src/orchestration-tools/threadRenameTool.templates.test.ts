import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";
import { renderPiOrchestrationBridgeSource } from "./PiOrchestrationBridge.template.ts";
import {
  renderOpencodeOrchestrationRuntimeSource,
  renderOpencodeRenameThreadToolSource,
} from "./opencodeThreadOrchestrationTools.ts";
import type { ThreadOrchestrationHttpConfig } from "./threadOrchestrationBridge.shared.ts";

/** Runs only generated owned fixture tools against a loopback HTTP recorder. */
async function withFixture(
  run: (
    config: ThreadOrchestrationHttpConfig,
    requests: Array<Record<string, unknown>>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "canonical-rename-template-"));
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    expect(request.headers["x-bigbud-thread-tool-token"]).toBe("owned-fixture-token");
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, title: "ohno" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  try {
    await run(
      {
        host: "127.0.0.1",
        port: address.port,
        threadId: "canonical-caller",
        token: "owned-fixture-token",
        providerSessionId: "owned-native-session",
        providerInvocationStatePath: join(directory, "mcp-identity.json"),
      },
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function runSource(source: string, input = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exit = once(child, "exit");
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code] = await exit;
    expect(code, stderr).toBe(0);
    return stdout;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

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
    const agentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const aiUrl = pathToFileURL(
      join(dirname(fileURLToPath(agentUrl)), "../../pi-ai/dist/index.js"),
    ).href;
    const source = renderPiOrchestrationBridgeSource(config)
      .replace('"@earendil-works/pi-ai"', JSON.stringify(aiUrl))
      .replace('"@earendil-works/pi-coding-agent"', JSON.stringify(agentUrl));
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
