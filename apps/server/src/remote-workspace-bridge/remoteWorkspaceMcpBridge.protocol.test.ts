import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderRemoteWorkspaceMcpServerSource } from "./remoteWorkspaceMcpBridge.template.ts";

type Framing = "content-length" | "newline";
type FixtureMode = "success" | "refused" | "unauthorized" | "bad-gateway";
type JsonRecord = Record<string, unknown>;
type FileSnapshot = { readonly exists: boolean; readonly content: string | undefined };

function snapshotFile(path: string): FileSnapshot {
  const exists = existsSync(path);
  return { exists, content: exists ? readFileSync(path, "utf8") : undefined };
}

function encodeMessage(message: JsonRecord, framing: Framing): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (framing === "newline") {
    return Buffer.concat([body, Buffer.from("\n")]);
  }
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "utf8"), body]);
}

function parseMessages(
  input: Buffer<ArrayBufferLike>,
  onMessage: (message: JsonRecord) => void,
): Buffer<ArrayBufferLike> {
  let buffer = input;
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    const prefix = buffer.toString("utf8", 0, Math.min(buffer.length, 32));
    if (/^Content-Length:/i.test(prefix)) {
      if (headerEnd === -1) break;
      const header = buffer.toString("utf8", 0, headerEnd);
      const length = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isInteger(length)) {
        throw new Error("Invalid content-length response: " + header);
      }
      const total = headerEnd + 4 + length;
      if (buffer.length < total) break;
      onMessage(JSON.parse(buffer.subarray(headerEnd + 4, total).toString("utf8")));
      buffer = buffer.subarray(total);
      continue;
    }

    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.subarray(0, newline).toString("utf8").trim();
    buffer = buffer.subarray(newline + 1);
    if (line) onMessage(JSON.parse(line));
  }
  return buffer;
}

function bridgeHarness(source: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source]);
  const messages: JsonRecord[] = [];
  const waiters: Array<(message: JsonRecord) => void> = [];
  let outputBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let totalMessages = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    outputBuffer = parseMessages(Buffer.concat([outputBuffer, chunk]), (message) => {
      totalMessages += 1;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    });
  });

  const nextMessage = (timeoutMs = 2_000): Promise<JsonRecord> => {
    const queued = messages.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(resolve);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for bridge response."));
      }, timeoutMs);
      waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };

  const send = (messagesToSend: ReadonlyArray<JsonRecord>, framing: Framing): void => {
    child.stdin.write(
      Buffer.concat(messagesToSend.map((message) => encodeMessage(message, framing))),
    );
  };

  const sendFragmented = async (
    message: JsonRecord,
    framing: Framing,
    splitAt: number,
  ): Promise<void> => {
    const encoded = encodeMessage(message, framing);
    child.stdin.write(encoded.subarray(0, splitAt));
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.stdin.write(encoded.subarray(splitAt));
  };

  return {
    child,
    nextMessage,
    send,
    sendFragmented,
    get totalMessages() {
      return totalMessages;
    },
  };
}

async function flushBridge(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function openFixture(mode: Exclude<FixtureMode, "refused">): Promise<{
  readonly port: number;
  readonly requests: JsonRecord[];
  readonly server: Server;
}> {
  const requests: JsonRecord[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push(JSON.parse(body));
    if (mode === "unauthorized") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "fixture authentication failed" }));
      return;
    }
    if (mode === "bad-gateway") {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "remote execution failed in fixture agent" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { stdout: "fixture-ok\n", stderr: "", code: 0 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind.");
  return { port: address.port, requests, server };
}

async function closedPort(): Promise<{
  readonly port: number;
  readonly requests: JsonRecord[];
  readonly server: Server;
}> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind.");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { port, requests: [], server };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withBridge<T>(
  mode: FixtureMode,
  callback: (input: {
    readonly harness: ReturnType<typeof bridgeHarness>;
    readonly requests: JsonRecord[];
    readonly statePath: string;
  }) => Promise<T>,
): Promise<T> {
  const fixture = mode === "refused" ? await closedPort() : await openFixture(mode);
  const stateRoot = mkdtempSync(join(tmpdir(), "bigbud-remote-mcp-protocol-"));
  const statePath = join(stateRoot, "mcp-invocation-state.json");
  const source = renderRemoteWorkspaceMcpServerSource({
    host: "127.0.0.1",
    port: fixture.port,
    threadId: "protocol-thread",
    token: "fixture-token",
    providerSessionId: "protocol-provider-session",
    providerInvocationStatePath: statePath,
  });
  const harness = bridgeHarness(source);
  try {
    return await callback({
      harness,
      requests: fixture.requests,
      statePath,
    });
  } finally {
    harness.child.kill();
    await closeServer(fixture.server);
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
};

describe("remote workspace MCP protocol", () => {
  it.each(["newline", "content-length"] as const)(
    "suppresses notifications and preserves request IDs with %s framing",
    async (framing) => {
      await withBridge("success", async ({ harness, requests, statePath }) => {
        await harness.sendFragmented(initialize, framing, 1);
        expect(await harness.nextMessage()).toMatchObject({
          id: 1,
          result: { capabilities: { tools: {} } },
        });

        const stateBeforeNotifications = snapshotFile(statePath);
        harness.send(
          [
            { jsonrpc: "2.0", method: "notifications/initialized" },
            { jsonrpc: "2.0", method: "notifications/roots/list_changed" },
            { jsonrpc: "2.0", method: "notifications/cancelled" },
            { jsonrpc: "2.0", method: "notifications/future" },
            { jsonrpc: "2.0", method: "ping" },
            { jsonrpc: "2.0", method: "tools/list" },
            {
              jsonrpc: "2.0",
              method: "tools/call",
              params: { name: "bash", arguments: { command: "printf ignored" } },
            },
          ],
          framing,
        );
        await flushBridge();
        expect(harness.totalMessages).toBe(1);
        expect(requests).toHaveLength(0);
        expect(snapshotFile(statePath)).toEqual(stateBeforeNotifications);

        harness.send(
          [
            { jsonrpc: "2.0", id: 0, method: "ping" },
            { jsonrpc: "2.0", id: "unknown-string", method: "future/request" },
            {
              jsonrpc: "2.0",
              id: 0,
              method: "tools/call",
              params: { name: "bash", arguments: { command: "printf ok" } },
            },
          ],
          framing,
        );

        const responses = [
          await harness.nextMessage(),
          await harness.nextMessage(),
          await harness.nextMessage(),
        ];
        expect(responses.map((message) => message.id).toSorted()).toEqual(
          [0, 0, "unknown-string"].toSorted(),
        );
        expect(responses).toContainEqual(expect.objectContaining({ id: 0, result: {} }));
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: "unknown-string",
            error: { code: -32601, message: "Method not found: future/request" },
          }),
        );
        expect(responses).toContainEqual(
          expect.objectContaining({
            id: 0,
            result: { content: [{ type: "text", text: "fixture-ok" }] },
          }),
        );
        expect(responses.every((message) => message.id !== null)).toBe(true);
        expect(requests).toHaveLength(1);
        expect(existsSync(statePath)).toBe(true);
        expect(harness.totalMessages).toBe(4);
      });
    },
  );

  it.each(["refused", "unauthorized", "bad-gateway"] as const)(
    "keeps the pipe usable after a %s tool failure",
    async (mode) => {
      await withBridge(mode, async ({ harness, requests }) => {
        harness.send([initialize], "newline");
        expect(await harness.nextMessage()).toMatchObject({ id: 1 });
        harness.send(
          [
            { jsonrpc: "2.0", method: "notifications/initialized" },
            {
              jsonrpc: "2.0",
              id: "failure-id",
              method: "tools/call",
              params: { name: "bash", arguments: { command: "printf failure" } },
            },
          ],
          "newline",
        );
        const failure = await harness.nextMessage();
        expect(failure).toMatchObject({
          id: "failure-id",
          result: { isError: true },
        });
        const content = (failure.result as JsonRecord | undefined)?.content;
        const firstContent = Array.isArray(content) ? content[0] : undefined;
        const failureText =
          firstContent && typeof firstContent === "object"
            ? String((firstContent as JsonRecord).text ?? "")
            : "";
        if (mode === "unauthorized") {
          expect(failureText).toContain("fixture authentication failed");
        } else if (mode === "bad-gateway") {
          expect(failureText).toContain("remote execution failed in fixture agent");
        } else {
          expect(failureText).toContain("fetch failed");
        }
        expect(requests).toHaveLength(mode === "refused" ? 0 : 1);
        harness.send(
          [
            { jsonrpc: "2.0", id: 0, method: "ping" },
            { jsonrpc: "2.0", id: "after-list", method: "tools/list" },
          ],
          "newline",
        );
        expect(await harness.nextMessage()).toMatchObject({ id: 0, result: {} });
        expect(await harness.nextMessage()).toMatchObject({
          id: "after-list",
          result: { tools: expect.any(Array) },
        });
        expect(requests).toHaveLength(mode === "refused" ? 0 : 1);
      });
    },
  );
});
