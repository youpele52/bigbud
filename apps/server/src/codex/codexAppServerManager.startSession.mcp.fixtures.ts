import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { vi } from "vitest";

import type {
  CodexAppServerStartSessionInput,
  JsonRpcRequest,
} from "./codexAppServerManager.types.ts";

function ignoreRequest(_request: JsonRpcRequest): void {}

export interface CodexSessionFixture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly requests: ReadonlyArray<JsonRpcRequest>;
  readonly respond: (request: JsonRpcRequest, result: unknown) => void;
  readonly respondError: (request: JsonRpcRequest, message: string) => void;
  readonly notify: (method: string, params?: unknown) => void;
  readonly nextRequest: (method: string) => Promise<JsonRpcRequest>;
  setRequestHandler(handler: (request: JsonRpcRequest) => void): void;
}

function writeJson(stream: PassThrough, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

export function createCodexSessionFixture(): CodexSessionFixture {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    killed: false,
    pid: 42,
    exitCode: null,
    kill: vi.fn(() => {
      (child as { killed: boolean }).killed = true;
      child.emit("exit", null, "SIGTERM");
      child.emit("close");
      return true;
    }),
  }) as unknown as ChildProcessWithoutNullStreams;
  const requests: JsonRpcRequest[] = [];
  const waiters: Array<{
    readonly method: string;
    readonly resolve: (request: JsonRpcRequest) => void;
  }> = [];
  let requestHandler = ignoreRequest;
  let stdinBuffer = "";

  stdin.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString("utf8");
    let newlineIndex = stdinBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = stdinBuffer.slice(0, newlineIndex).trim();
      stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
      newlineIndex = stdinBuffer.indexOf("\n");
      if (!line) continue;
      const request = JSON.parse(line) as JsonRpcRequest;
      requests.push(request);
      const waiterIndex = waiters.findIndex(({ method }) => method === request.method);
      if (waiterIndex !== -1) {
        const waiter = waiters.splice(waiterIndex, 1)[0];
        waiter?.resolve(request);
      }
      requestHandler(request);
    }
  });

  return {
    child,
    requests,
    respond: (request, result) => writeJson(stdout, { jsonrpc: "2.0", id: request.id, result }),
    respondError: (request, message) =>
      writeJson(stdout, {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message },
      }),
    notify: (method, params) =>
      writeJson(stdout, { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    nextRequest: (method) => {
      const existingIndex = requests.findIndex((request) => request.method === method);
      if (existingIndex !== -1) {
        const existing = requests[existingIndex];
        if (existing) return Promise.resolve(existing);
      }
      return new Promise((resolve) => waiters.push({ method, resolve }));
    },
    setRequestHandler: (handler) => {
      requestHandler = handler;
    },
  };
}

export function baseCodexSessionInput(
  overrides: Partial<CodexAppServerStartSessionInput> = {},
): CodexAppServerStartSessionInput {
  return {
    threadId: "caller-thread" as CodexAppServerStartSessionInput["threadId"],
    binaryPath: "codex",
    cwd: "/workspace",
    runtimeMode: "full-access",
    requiredMcpServerNames: ["bigbud_remote_workspace"],
    ...overrides,
  };
}

export function respondToBootstrapRequest(
  fixture: CodexSessionFixture,
  request: JsonRpcRequest,
  options: { readonly statusProbeUnavailable?: boolean } = {},
): boolean {
  if (request.method === "initialize") {
    fixture.respond(request, {});
    return true;
  }
  if (request.method === "model/list") {
    fixture.respond(request, { data: [] });
    return true;
  }
  if (request.method === "account/read") {
    fixture.respond(request, { account: { type: "chatgpt", planType: "pro" } });
    return true;
  }
  if (request.method === "mcpServerStatus/list") {
    if (options.statusProbeUnavailable) {
      fixture.respondError(request, "mcpServerStatus/list unavailable");
    } else {
      fixture.respond(request, {
        servers: [{ name: "bigbud_orchestration", startupStatus: "ready" }],
      });
    }
    return true;
  }
  return false;
}
