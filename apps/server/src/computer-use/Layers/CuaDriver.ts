import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { Effect, Layer, Semaphore } from "effect";
import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverMcpArguments,
} from "@bigbud/shared/cua-driver/invocation";
import { CUA_DRIVER_REQUIRED_TOOLS } from "@bigbud/shared/cua-driver/policy";

import {
  CuaDriver,
  CuaDriverError,
  type CuaDriverCallResult,
  type CuaDriverShape,
} from "../Services/CuaDriver.ts";
import { resetCuaDriverDaemon } from "./CuaDriver.reset.ts";
import {
  formatCuaDriverHealthReport,
  requireCuaDriverEmbeddedHostBundleId,
  type CuaDriverSession,
} from "./CuaDriver.runtime.ts";

const JSONRPC_VERSION = "2.0";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CUA_DRIVER_REQUEST_TIMEOUT_MS = 60 * 60_000;
const CUA_DRIVER_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const CUA_DRIVER_STDERR_TAIL_BYTES = 4 * 1024;
const MUTATING_TOOLS = new Set([
  "launch_app",
  "bring_to_front",
  "click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
]);
const stderrTails = new WeakMap<ChildProcessWithoutNullStreams, string>();

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

function stderrSuffix(child: ChildProcessWithoutNullStreams): string {
  const tail = stderrTails.get(child)?.trim();
  return tail ? ` Driver diagnostics: ${tail.slice(-1_024)}` : "";
}

function writeMessage(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
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
  child: ChildProcessWithoutNullStreams,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`cua-driver MCP request '${method}' timed out.`));
    }, CUA_DRIVER_REQUEST_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
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
        new Error(
          `cua-driver mcp exited (code=${code ?? "null"}, signal=${signal ?? "null"}).${stderrSuffix(child)}`,
        ),
      );
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
    child.once("exit", onExit);
    void writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params ? { params } : {}),
    }).catch(onError);
  });
}

export function toCallResult(result: unknown): CuaDriverCallResult {
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
  if (record.isError === true) {
    const message = content.find((entry) => entry.text)?.text;
    throw new Error(message ?? "cua-driver reported an MCP tool error.");
  }
  return {
    content,
    ...(record.structuredContent === undefined
      ? {}
      : { structuredContent: record.structuredContent }),
  };
}

export function parseAvailableTools(result: unknown): ReadonlySet<string> {
  if (!result || typeof result !== "object") return new Set();
  const tools = (result as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return new Set();
  return new Set(
    tools.flatMap((tool) =>
      tool && typeof tool === "object" && typeof tool.name === "string" ? [tool.name] : [],
    ),
  );
}

async function createSession(): Promise<CuaDriverSession> {
  const socketPath =
    process.env.BIGBUD_CUA_ENDPOINT?.trim() ?? process.env.BIGBUD_CUA_DRIVER_SOCKET?.trim();
  const hostBundleId = socketPath ? requireCuaDriverEmbeddedHostBundleId(process.env) : undefined;
  const child = spawn(
    resolveCuaDriverCommand(),
    socketPath ? [...cuaDriverMcpArguments(socketPath, hostBundleId!)] : ["mcp"],
    {
      env: makeCuaDriverChildEnvironment(
        process.env,
        socketPath ? cuaDriverEmbeddedEnvironment(socketPath, hostBundleId!) : {},
      ),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    },
  );
  stderrTails.set(child, "");
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrTails.set(
      child,
      `${stderrTails.get(child) ?? ""}${chunk.toString()}`.slice(-CUA_DRIVER_STDERR_TAIL_BYTES),
    );
  });
  try {
    await requestResponse(child, 1, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "bigbud", version: "1.0.0" },
    });
    await writeMessage(child, {
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/initialized",
    });
    const availableTools = parseAvailableTools(await requestResponse(child, 2, "tools/list"));
    const missingTools = CUA_DRIVER_REQUIRED_TOOLS.filter((name) => !availableTools.has(name));
    if (missingTools.length > 0) {
      throw new Error(`cua-driver is missing required tools: ${missingTools.join(", ")}.`);
    }
    return { child, availableTools, nextId: 3 };
  } catch (error) {
    stopChild(child);
    throw error;
  }
}

function isSessionAlive(session: CuaDriverSession | null): session is CuaDriverSession {
  return session !== null && session.child.exitCode === null && session.child.signalCode === null;
}

function makeCuaDriver(): CuaDriverShape {
  let session: CuaDriverSession | null = null;
  let unavailableReason: string | null = null;
  let queue: Promise<void> = Promise.resolve();
  const operationSemaphore = Effect.runSync(Semaphore.make(1));

  async function callToolViaSession(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CuaDriverCallResult> {
    if (unavailableReason) throw new Error(unavailableReason);
    if (!isSessionAlive(session)) {
      session = await createSession();
    }
    if (!session.availableTools.has(name)) {
      throw new Error(`cua-driver did not advertise tool '${name}'.`);
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
      if (
        MUTATING_TOOLS.has(name) &&
        error instanceof Error &&
        error.message.includes("timed out")
      ) {
        await resetDaemonAfterUncertainAction(`Tool '${name}' timed out.`);
      }
      throw error;
    }
  }

  function enqueueCall<T>(work: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        release();
      });
  }

  function resetProxy(): void {
    if (isSessionAlive(session)) stopChild(session.child);
    session = null;
  }

  async function resetDaemonAfterUncertainAction(reason: string): Promise<void> {
    resetProxy();
    const socketPath =
      process.env.BIGBUD_CUA_ENDPOINT?.trim() ?? process.env.BIGBUD_CUA_DRIVER_SOCKET?.trim();
    if (!socketPath) {
      unavailableReason = `Computer Use is unavailable after an uncertain action: ${reason}`;
      throw new Error(unavailableReason);
    }
    try {
      await resetCuaDriverDaemon({
        command: resolveCuaDriverCommand(),
        socketPath,
        reason,
      });
      unavailableReason = null;
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  const resetAfterUncertainAction = (reason: string) =>
    Effect.tryPromise({
      try: () => resetDaemonAfterUncertainAction(reason),
      catch: (cause) =>
        toDriverError(cause, "Failed to reset Computer Use after an uncertain action."),
    });

  return {
    callTool: (name, args) =>
      Effect.callback<CuaDriverCallResult, CuaDriverError>((resume) => {
        let active = true;
        void enqueueCall(() => callToolViaSession(name, args)).then(
          (result) => {
            if (active) resume(Effect.succeed(result));
          },
          (cause) => {
            if (active) {
              resume(
                Effect.fail(toDriverError(cause, `Failed to call cua-driver tool '${name}'.`)),
              );
            }
          },
        );
        return Effect.sync(() => {
          active = false;
        }).pipe(
          Effect.andThen(
            MUTATING_TOOLS.has(name)
              ? resetAfterUncertainAction(`Tool '${name}' was interrupted.`).pipe(Effect.ignore)
              : Effect.sync(resetProxy),
          ),
        );
      }),
    runDoctor: () =>
      Effect.tryPromise({
        try: () =>
          enqueueCall(async () =>
            formatCuaDriverHealthReport(await callToolViaSession("health_report", {})),
          ),
        catch: (cause) => toDriverError(cause, "Failed to read cua-driver health."),
      }),
    withExclusiveAccess: (effect) => operationSemaphore.withPermit(effect),
    resetProxy: Effect.sync(resetProxy),
    resetAfterUncertainAction,
    dispose: Effect.sync(() => {
      resetProxy();
    }),
  };
}

export const CuaDriverLive = Layer.succeed(CuaDriver, makeCuaDriver());
