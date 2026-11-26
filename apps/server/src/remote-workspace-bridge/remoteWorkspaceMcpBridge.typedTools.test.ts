import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";

import { renderRemoteWorkspaceMcpServerSource } from "./remoteWorkspaceMcpBridge.template.ts";

async function callTool(source: string, name: string, args: Record<string, unknown>) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stdin.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`,
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await once(child, "exit");
    return JSON.parse(output.trim()) as { result?: { content?: Array<{ text: string }> } };
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

const text = (reply: Awaited<ReturnType<typeof callTool>>) => reply.result?.content?.[0]?.text;

it("sends file tools as typed remoteTool requests and bash as `sh -lc <text>` with no stdin", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    requests.push(parsed);
    const tool = (parsed.remoteTool as { tool?: string } | undefined)?.tool;
    const result =
      tool === "read_text"
        ? { tool: { tool, content: "one\ntwo\nthree\n" } }
        : tool === "list_dir"
          ? {
              tool: {
                tool,
                entries: [
                  { name: "b", directory: true },
                  { name: "a", directory: false },
                ],
              },
            }
          : tool === "search"
            ? { tool: { tool, matches: [{ path: "src/x.ts", line: 3, text: "needle" }] } }
            : tool === "glob"
              ? { tool: { tool, paths: ["a.ts", "b/c.ts"], truncated: false } }
              : tool
                ? { tool: { tool } }
                : { stdout: "bash out", stderr: "", code: 0 };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result }));
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
    expect(text(await callTool(source, "read", { path: "f.txt", offset: 2, limit: 1 }))).toBe(
      "two\n\n[Showing lines 2-2 of 3. Use offset=3 to continue.]",
    );
    await callTool(source, "write", { path: "dir/f.txt", content: "hello" });
    await callTool(source, "edit", { path: "f.txt", oldText: "two", newText: "TWO" });
    expect(text(await callTool(source, "list", { path: "src" }))).toBe("src/a\nsrc/b");
    expect(text(await callTool(source, "grep", { pattern: "needle", path: "src" }))).toBe(
      "src/x.ts:3:needle",
    );
    expect(text(await callTool(source, "glob", { pattern: "**/*.ts", path: "src" }))).toBe(
      "a.ts\nb/c.ts",
    );
    await callTool(source, "apply_patch", { patch: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n" });
    expect(text(await callTool(source, "bash", { command: "ls -la" }))).toBe("bash out");
    const typed = requests.filter((request) => request.remoteTool !== undefined);
    expect(typed.map((request) => (request.remoteTool as { tool: string }).tool)).toEqual([
      "read_text",
      "write_text",
      "read_text",
      "write_text",
      "list_dir",
      "search",
      "glob",
      "apply_patch",
    ]);
    expect(typed[3]!.remoteTool).toEqual({
      tool: "write_text",
      path: "f.txt",
      content: "one\nTWO\nthree\n",
    });
    for (const request of typed) {
      expect(request.remoteCommand).toBeUndefined();
      expect(request.remoteStdin).toBeUndefined();
    }
    const bash = requests.find((request) => request.remoteCommand !== undefined)!;
    expect(bash).toMatchObject({ remoteCommand: "sh", remoteArgs: ["-lc", "ls -la"] });
    expect(bash.remoteStdin).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
