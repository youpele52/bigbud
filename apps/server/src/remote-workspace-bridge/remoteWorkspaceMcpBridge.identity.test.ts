import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderRemoteWorkspaceMcpServerSource } from "./remoteWorkspaceMcpBridge.template.ts";

async function call(
  source: string,
  input: { readonly id?: string | number; readonly identity?: string } = {},
) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: input.id ?? 1,
      method: "tools/call",
      params: {
        name: "bash",
        arguments: { command: "printf marker" },
        ...(input.identity ? { _meta: { "bigbud/toolInvocationId": input.identity } } : {}),
      },
    }) + "\n",
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    return JSON.parse(output.trim());
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

async function callMany(source: string, inputs: ReadonlyArray<{ readonly id: string | number }>) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stdin.end(
    inputs
      .map((input) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          method: "tools/call",
          params: { name: "bash", arguments: { command: "printf marker" } },
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

it("uses standard JSON-RPC request identity for ordinary providers and preserves explicit metadata", async () => {
  const requests: Array<{ remoteInvocationId: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { stdout: "ok", stderr: "", code: 0 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const source = renderRemoteWorkspaceMcpServerSource({
    host: "127.0.0.1",
    port: address.port,
    threadId: "thread",
    token: "fixture",
    providerSessionId: "claude:session-1:3",
  });
  try {
    for (let restart = 0; restart < 2; restart++)
      expect((await call(source)).result).toMatchObject({ content: [{ text: "ok" }] });
    await call(source, { id: "retry-1" });
    await call(source, { id: "retry-1" });
    await call(source, { id: "distinct", identity: "origin-2" });
    expect(requests.map((request) => request.remoteInvocationId)).toEqual([
      "mcp-request:claude:session-1:3:number:1:0",
      "mcp-request:claude:session-1:3:number:1:0",
      "mcp-request:claude:session-1:3:string:retry-1:0",
      "mcp-request:claude:session-1:3:string:retry-1:0",
      "mcp-meta:claude:session-1:3:origin-2:0",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps typed ordinary IDs distinct and fences reused IDs after provider bridge restart", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "bigbud-mcp-identity-"));
  const requests: Array<{ remoteInvocationId: string }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: { stdout: "ok", stderr: "", code: 0 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const source = renderRemoteWorkspaceMcpServerSource({
    host: "127.0.0.1",
    port: address.port,
    threadId: "thread",
    token: "fixture",
    providerSessionId: "provider-session",
    providerInvocationStatePath: join(stateRoot, "mcp-state.json"),
  });
  try {
    await callMany(source, [{ id: 1 }, { id: "1" }, { id: 1 }]);
    expect(requests.map((request) => request.remoteInvocationId)).toEqual([
      "mcp-sequence:provider-session:1:0",
      "mcp-sequence:provider-session:2:0",
      "mcp-sequence:provider-session:1:0",
    ]);
    const replay = await call(source, { id: 1 });
    expect(replay.result.content[0].text).toContain(
      "REMOTE_INVOCATION_IDENTITY_REQUIRED_REPLAY_AMBIGUOUS",
    );
    expect(requests).toHaveLength(3);
    await expect(call(source, { id: 2 })).resolves.toMatchObject({
      result: { content: [{ text: "ok" }] },
    });
    expect(requests.at(-1)?.remoteInvocationId).toBe("mcp-sequence:provider-session:3:0");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
