import type { ChildProcessWithoutNullStreams } from "node:child_process";

const JSONRPC_VERSION = "2.0";
const CUA_DRIVER_REQUEST_TIMEOUT_MS = 60 * 60_000;
const CUA_DRIVER_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const stderrTails = new WeakMap<ChildProcessWithoutNullStreams, string>();

function stderrSuffix(child: ChildProcessWithoutNullStreams): string {
  const tail = stderrTails.get(child)?.trim();
  return tail ? ` Driver diagnostics: ${tail.slice(-1_024)}` : "";
}

export function writeMessage(
  child: ChildProcessWithoutNullStreams,
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

export async function requestResponse(
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
