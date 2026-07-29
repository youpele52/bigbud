import * as ChildProcess from "node:child_process";
import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverMcpArguments,
} from "@bigbud/shared/cua-driver/invocation";
import { CUA_DRIVER_REQUIRED_TOOLS } from "@bigbud/shared/cua-driver/policy";

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CUA_DRIVER_REQUEST_TIMEOUT_MS = 15 * 60_000;
const CUA_DRIVER_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

interface CuaDriverMcpOptions {
  readonly socketPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

function parseToolNames(result: unknown): ReadonlySet<string> {
  if (!result || typeof result !== "object") return new Set();
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return new Set();
  return new Set(
    tools.flatMap((tool) =>
      tool && typeof tool === "object" && typeof tool.name === "string" ? [tool.name] : [],
    ),
  );
}

function writeMessage(
  child: ChildProcess.ChildProcessWithoutNullStreams,
  message: unknown,
): Promise<void> {
  const body = JSON.stringify(message);
  return new Promise((resolve, reject) => {
    child.stdin.write(`${body}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function requestResponse(
  child: ChildProcess.ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CUA_DRIVER_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`cua-driver MCP request '${method}' timed out.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onClosed);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClosed = (...details: ReadonlyArray<unknown>) => {
      cleanup();
      reject(new Error(`cua-driver MCP transport closed (${details.join(", ") || "no details"}).`));
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CUA_DRIVER_MAX_MESSAGE_BYTES) {
        cleanup();
        reject(new Error("cua-driver MCP response exceeded the maximum size."));
        return;
      }
      for (;;) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) {
          return;
        }
        const body = buffer.slice(0, lineEnd).toString("utf8").trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!body) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(body) as Record<string, unknown>;
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (message.id !== id) {
          continue;
        }
        cleanup();
        if (message.error && typeof message.error === "object") {
          const errorRecord = message.error as Record<string, unknown>;
          reject(
            new Error(
              typeof errorRecord.message === "string"
                ? errorRecord.message
                : "cua-driver returned an MCP error.",
            ),
          );
          return;
        }
        resolve(message.result);
        return;
      }
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onClosed);
    void writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params ? { params } : {}),
    }).catch(onError);
  });
}

interface PersistentMcpSession {
  readonly key: string;
  readonly child: ChildProcess.ChildProcessWithoutNullStreams;
  availableTools: ReadonlySet<string> | null;
  nextRequestId: number;
  queue: Promise<void>;
}

let persistentSession: PersistentMcpSession | null = null;

function stopSession(session: PersistentMcpSession): void {
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.child.kill("SIGTERM");
  }
}

export function stopCuaDriverMcpClient(): void {
  const session = persistentSession;
  persistentSession = null;
  if (session) stopSession(session);
}

function readEmbeddedHostBundleId(environment: NodeJS.ProcessEnv): string {
  const hostBundleId =
    environment.BIGBUD_CUA_HOST_BUNDLE_ID?.trim() ?? environment.CUA_DRIVER_HOST_BUNDLE_ID?.trim();
  if (!hostBundleId) {
    throw new Error("Embedded cua-driver MCP requires the Electron host bundle ID.");
  }
  return hostBundleId;
}

function createMcpChild(
  binaryPath: string,
  socketPath: string | undefined,
  environment: NodeJS.ProcessEnv,
): ChildProcess.ChildProcessWithoutNullStreams {
  const hostBundleId = socketPath ? readEmbeddedHostBundleId(environment) : undefined;
  const child = ChildProcess.spawn(
    binaryPath,
    socketPath ? [...cuaDriverMcpArguments(socketPath, hostBundleId!)] : ["mcp"],
    {
      env: makeCuaDriverChildEnvironment(
        environment,
        socketPath ? cuaDriverEmbeddedEnvironment(socketPath, hostBundleId!) : {},
      ),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  child.stderr.on("data", () => {});
  return child;
}

function getPersistentSession(
  binaryPath: string,
  socketPath: string,
  environment: NodeJS.ProcessEnv,
): PersistentMcpSession {
  const key = `${binaryPath}\0${socketPath}`;
  if (
    persistentSession?.key === key &&
    persistentSession.child.exitCode === null &&
    persistentSession.child.signalCode === null
  ) {
    return persistentSession;
  }
  if (persistentSession) stopSession(persistentSession);
  persistentSession = {
    key,
    child: createMcpChild(binaryPath, socketPath, environment),
    availableTools: null,
    nextRequestId: 1,
    queue: Promise.resolve(),
  };
  return persistentSession;
}

async function initializeSession(
  session: PersistentMcpSession,
  timeoutMs: number | undefined,
): Promise<ReadonlySet<string>> {
  if (session.availableTools) return session.availableTools;
  const initializeId = session.nextRequestId++;
  await requestResponse(
    session.child,
    initializeId,
    "initialize",
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bigbud-desktop", version: "1.0.0" },
    },
    timeoutMs,
  );
  await writeMessage(session.child, {
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
  const toolsId = session.nextRequestId++;
  session.availableTools = parseToolNames(
    await requestResponse(session.child, toolsId, "tools/list", undefined, timeoutMs),
  );
  return session.availableTools;
}

function validateAvailableTool(availableTools: ReadonlySet<string>, toolName: string): void {
  const missingTools = CUA_DRIVER_REQUIRED_TOOLS.filter((name) => !availableTools.has(name));
  if (missingTools.length > 0) {
    throw new Error(`cua-driver is missing required tools: ${missingTools.join(", ")}.`);
  }
  if (!availableTools.has(toolName)) {
    throw new Error(`cua-driver did not advertise tool '${toolName}'.`);
  }
}

function unwrapToolResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    (result as Record<string, unknown>).isError !== true
  ) {
    return result;
  }
  const content = (result as Record<string, unknown>).content;
  const message = Array.isArray(content)
    ? content.find((entry): entry is { text: string } =>
        Boolean(entry && typeof entry === "object" && typeof entry.text === "string"),
      )?.text
    : undefined;
  throw new Error(message ?? "cua-driver reported an MCP tool error.");
}

async function callPersistentSessionTool(
  session: PersistentMcpSession,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number | undefined,
): Promise<unknown> {
  const previous = session.queue;
  let release!: () => void;
  session.queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    validateAvailableTool(await initializeSession(session, timeoutMs), toolName);
    const requestId = session.nextRequestId++;
    return unwrapToolResult(
      await requestResponse(
        session.child,
        requestId,
        "tools/call",
        { name: toolName, arguments: args },
        timeoutMs,
      ),
    );
  } catch (error) {
    if (persistentSession === session) persistentSession = null;
    stopSession(session);
    throw error;
  } finally {
    release();
  }
}

export async function callCuaDriverTool(
  binaryPath: string,
  toolName: string,
  args: Record<string, unknown>,
  options: CuaDriverMcpOptions = {},
): Promise<unknown> {
  const socketPath =
    options.socketPath ??
    options.environment?.BIGBUD_CUA_ENDPOINT?.trim() ??
    options.environment?.BIGBUD_CUA_DRIVER_SOCKET?.trim() ??
    process.env.BIGBUD_CUA_ENDPOINT?.trim() ??
    process.env.BIGBUD_CUA_DRIVER_SOCKET?.trim();
  const environment = options.environment ?? process.env;
  if (socketPath) {
    return callPersistentSessionTool(
      getPersistentSession(binaryPath, socketPath, environment),
      toolName,
      args,
      options.timeoutMs,
    );
  }
  const child = createMcpChild(binaryPath, undefined, environment);

  try {
    await requestResponse(child, 1, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bigbud-desktop", version: "1.0.0" },
    });
    await writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/initialized",
    });
    const availableTools = parseToolNames(await requestResponse(child, 2, "tools/list"));
    validateAvailableTool(availableTools, toolName);
    const result = await requestResponse(child, 3, "tools/call", {
      name: toolName,
      arguments: args,
    });
    return unwrapToolResult(result);
  } finally {
    child.kill("SIGTERM");
  }
}
