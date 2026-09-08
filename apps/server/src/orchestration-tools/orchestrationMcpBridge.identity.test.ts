import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { renderOrchestrationMcpServerSource } from "./orchestrationMcpBridge.template.ts";

async function callMany(source: string, ids: ReadonlyArray<string | number>) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stdin.end(
    ids
      .map((id) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "list_notes", arguments: {} },
        }),
      )
      .join("\n") + "\n",
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    return output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

it("keeps typed orchestration MCP IDs separate and rejects an ambiguous restarted retry", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "bigbud-orchestration-mcp-identity-"));
  const requests: Array<{ invocationId: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: {} }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const source = renderOrchestrationMcpServerSource({
    host: "127.0.0.1",
    port: address.port,
    threadId: "thread",
    token: "fixture",
    providerSessionId: "provider-session",
    providerInvocationStatePath: join(stateRoot, "mcp-state.json"),
  });
  try {
    await callMany(source, [1, "1", 1]);
    expect(requests.map((request) => request.invocationId)).toEqual([
      "mcp-sequence:provider-session:1",
      "mcp-sequence:provider-session:2",
      "mcp-sequence:provider-session:1",
    ]);
    const replay = await callMany(source, [1]);
    expect(replay[0].error.message).toContain("MCP_INVOCATION_IDENTITY_REQUIRED_REPLAY_AMBIGUOUS");
    expect(requests).toHaveLength(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
