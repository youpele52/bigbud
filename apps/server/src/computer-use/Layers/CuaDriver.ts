import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { Effect, Layer } from "effect";

import {
  CuaDriver,
  CuaDriverError,
  type CuaDriverCallResult,
  type CuaDriverShape,
} from "../Services/CuaDriver.ts";
import { runProcess } from "../../utils/processRunner.ts";

const JSONRPC_VERSION = "2.0";

function resolveCuaDriverCommand(): string {
  return process.env.BIGBUD_CUA_DRIVER_PATH?.trim() || "cua-driver";
}

function toDriverError(cause: unknown, fallback: string): CuaDriverError {
  if (cause instanceof CuaDriverError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new CuaDriverError({ message: cause.message, cause });
  }
  return new CuaDriverError({ message: fallback, cause });
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.removeAllListeners();
  child.stdin.removeAllListeners();
  child.stdout.removeAllListeners();
  child.stderr.removeAllListeners();
  child.kill("SIGTERM");
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
  const body = JSON.stringify(message);
  const encoded = Buffer.from(body, "utf8");
  return new Promise((resolve, reject) => {
    child.stdin.write(`Content-Length: ${encoded.length}\r\n\r\n${body}`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function requestResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`cua-driver mcp exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`),
      );
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }
        const header = buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const contentLength = Number(match[1]);
        const totalLength = headerEnd + 4 + contentLength;
        if (buffer.length < totalLength) {
          return;
        }
        const body = buffer.slice(headerEnd + 4, totalLength).toString("utf8");
        buffer = buffer.slice(totalLength);
        const message = JSON.parse(body) as Record<string, unknown>;
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
    child.once("exit", onExit);
    void writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params ? { params } : {}),
    }).catch(onError);
  });
}

function toCallResult(result: unknown): CuaDriverCallResult {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const content = Array.isArray(record.content)
    ? record.content.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const block = entry as Record<string, unknown>;
        if (typeof block.type !== "string") {
          return [];
        }
        return [
          {
            type: block.type,
            ...(typeof block.text === "string" ? { text: block.text } : {}),
            ...(typeof block.mimeType === "string" ? { mimeType: block.mimeType } : {}),
            ...(typeof block.data === "string" ? { data: block.data } : {}),
          },
        ];
      })
    : [];
  return {
    content,
    ...(record.structuredContent === undefined
      ? {}
      : { structuredContent: record.structuredContent }),
  };
}

interface CuaDriverSession {
  readonly child: ChildProcessWithoutNullStreams;
  nextId: number;
}

async function createSession(): Promise<CuaDriverSession> {
  const child = spawn(resolveCuaDriverCommand(), ["mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  child.stderr.on("data", () => {});
  const session: CuaDriverSession = { child, nextId: 3 };
  await requestResponse(child, 1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "bigbud", version: "1.0.0" },
  });
  await writeMessage(child, {
    jsonrpc: JSONRPC_VERSION,
    method: "notifications/initialized",
  });
  return session;
}

function isSessionAlive(session: CuaDriverSession | null): session is CuaDriverSession {
  return session !== null && session.child.exitCode === null && session.child.signalCode === null;
}

function makeCuaDriver(): CuaDriverShape {
  let session: CuaDriverSession | null = null;

  async function callToolViaSession(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CuaDriverCallResult> {
    if (!isSessionAlive(session)) {
      session = await createSession();
    }
    const id = session.nextId;
    session.nextId += 1;
    try {
      const result = await requestResponse(session.child, id, "tools/call", {
        name,
        arguments: args,
      });
      return toCallResult(result);
    } catch (error) {
      if (isSessionAlive(session)) {
        stopChild(session.child);
      }
      session = null;
      throw error;
    }
  }

  return {
    callTool: (name, args) =>
      Effect.promise(() => callToolViaSession(name, args)).pipe(
        Effect.mapError((cause) =>
          toDriverError(cause, `Failed to call cua-driver tool '${name}'.`),
        ),
      ),
    runDoctor: () =>
      Effect.promise(async () => {
        const result = await runProcess(resolveCuaDriverCommand(), ["doctor"], {
          allowNonZeroExit: true,
          timeoutMs: 30_000,
          outputMode: "truncate",
        });
        return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n");
      }).pipe(Effect.mapError((cause) => toDriverError(cause, "Failed to run cua-driver doctor."))),
    dispose: Effect.sync(() => {
      if (isSessionAlive(session)) {
        stopChild(session.child);
      }
      session = null;
    }),
  };
}

export const CuaDriverLive = Layer.succeed(CuaDriver, makeCuaDriver());
